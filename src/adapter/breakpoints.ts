// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {SourcePathResolver, Location, SourceContainer, Source} from './sources';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import {Thread, ThreadManager, Script} from './threads';
import * as vscode from 'vscode';

export class Breakpoint {
  private static _lastDapId = 0;
  private _manager: BreakpointManager;
  private _dapId: number;
  private _source: Dap.Source;
  private _condition?: string;
  private _lineNumber: number;  // 1-based
  private _columnNumber: number;  // 1-based
  private _disposables: vscode.Disposable[] = [];

  private _perThread = new Map<number, Set<string>>();
  private _resolvedLocation?: Location;

  constructor(manager: BreakpointManager, source: Dap.Source, params: Dap.SourceBreakpoint) {
    this._dapId = ++Breakpoint._lastDapId;
    this._manager = manager;
    this._source = source;
    this._lineNumber = params.line;
    this._columnNumber = params.column || 1;
    if (params.logMessage)
      this._condition = logMessageToExpression(params.logMessage);
    if (params.condition)
      this._condition = this._condition ? `(${params.condition}) && ${this._condition}` : params.condition;
  }

  async toDap(): Promise<Dap.Breakpoint> {
    return {
      id: this._dapId,
      verified: !!this._resolvedLocation,
      source: (this._resolvedLocation && this._resolvedLocation.source) ? await this._resolvedLocation.source.toDap() : undefined,
      line: this._resolvedLocation ? this._resolvedLocation.lineNumber : undefined,
      column: this._resolvedLocation ? this._resolvedLocation.columnNumber : undefined,
    }
  }

  async set(report: boolean): Promise<void> {
    const threadManager = this._manager._threadManager;
    threadManager.onThreadRemoved(thread => {
      this._perThread.delete(thread.threadId());
      if (!this._perThread.size) {
        this._resolvedLocation = undefined;
        this._manager._dap.breakpoint({reason: 'changed', breakpoint: {id: this._dapId, verified: false}});
      }
    }, undefined, this._disposables);

    const source = this._manager._sourceContainer.source(this._source);
    const url = source
      ? source.url() :
      (this._source.path ? this._manager._sourcePathResolver.resolveUrl(this._source.path) : undefined);
    const promises: Promise<void>[] = [];

    if (url) {
      // For breakpoints set before launch, we don't know whether they are in a compiled or
      // a source map source. To make them work, we always set by url to not miss compiled.
      const lineNumber = this._lineNumber - 1;
      const columnNumber = this._columnNumber - 1;
      promises.push(...threadManager.threads().map(thread => {
        return this._setByUrl(thread, url, lineNumber, columnNumber);
      }));
      threadManager.onThreadInitialized(thread => {
        this._setByUrl(thread, url, lineNumber, columnNumber);
      }, undefined, this._disposables);
    }

    const locations = this._manager._sourceContainer.siblingLocations({
      url: url || '',
      lineNumber: this._lineNumber,
      columnNumber: this._columnNumber,
      source
    });
    promises.push(...locations.map(location => this._setByLocation(location, source)));

    await Promise.all(promises);
    if (report)
      this._manager._dap.breakpoint({reason: 'changed', breakpoint: await this.toDap()});
  }

  breakpointResolved(thread: Thread, cdpId: string, resolvedLocations: Cdp.Debugger.Location[]) {
    if (this._manager._threadManager.thread(thread.threadId()) !== thread)
      return;
    let ids = this._perThread.get(thread.threadId());
    if (!ids) {
      ids = new Set<string>();
      this._perThread.set(thread.threadId(), ids);
    }
    ids.add(cdpId);
    this._manager._perThread.get(thread.threadId())!.set(cdpId, this);

    if (this._resolvedLocation || !resolvedLocations.length)
      return;
    const location = thread.rawLocationToUiLocation(resolvedLocations[0]);
    const source = this._manager._sourceContainer.source(this._source);
    if (source)
      this._resolvedLocation = this._manager._sourceContainer.siblingLocations(location, source)[0];
  }

  async updateForSourceMap(script: Script) {
    const source = this._manager._sourceContainer.source(this._source);
    if (!source)
      return;
    const locations = this._manager._sourceContainer.siblingLocations({
      url: source.url(),
      lineNumber: this._lineNumber,
      columnNumber: this._columnNumber,
      source
    }, script.source);
    const resolvedLocation = this._resolvedLocation;
    const promises: Promise<void>[] = [];
    for (const location of locations)
      promises.push(this._setByScriptId(script.thread, script.scriptId, location.lineNumber - 1, location.columnNumber - 1));
    await Promise.all(promises);
    if (resolvedLocation !== this._resolvedLocation)
      this._manager._dap.breakpoint({reason: 'changed', breakpoint: await this.toDap()});
  }

  async _setByLocation(location: Location, originalSource?: Source): Promise<void> {
    const promises: Promise<void>[] = [];
    if (location.source) {
      const scripts = this._manager._threadManager.scriptsFromSource(location.source);
      for (const script of scripts)
        promises.push(this._setByScriptId(script.thread, script.scriptId, location.lineNumber - 1, location.columnNumber - 1));
    }
    if (location.url && (!originalSource || location.source !== originalSource)) {
      for (const thread of this._manager._threadManager.threads()) {
        // We only do this to support older versions which do not implement 'pause before source map'.
        if (!thread.supportsSourceMapPause())
          promises.push(this._setByUrl(thread, location.url, location.lineNumber - 1, location.columnNumber - 1));
      }
    }
    await Promise.all(promises);
  }

  async _setByUrl(thread: Thread, url: string, lineNumber: number, columnNumber: number): Promise<void> {
    const result = await thread.cdp().Debugger.setBreakpointByUrl({
      url,
      lineNumber,
      columnNumber,
      condition: this._condition,
    });
    if (result)
      this.breakpointResolved(thread, result.breakpointId, result.locations);
  }

  async _setByScriptId(thread: Thread, scriptId: string, lineNumber: number, columnNumber: number): Promise<void> {
    const result = await thread.cdp().Debugger.setBreakpoint({
      location: {scriptId, lineNumber, columnNumber},
      condition: this._condition,
    });
    if (result)
      this.breakpointResolved(thread, result.breakpointId, [result.actualLocation]);
  }

  async remove(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const [threadId, ids] of this._perThread) {
      const thread = this._manager._threadManager.thread(threadId)!;
      for (const id of ids) {
        this._manager._perThread.get(threadId)!.delete(id);
        promises.push(thread.cdp().Debugger.removeBreakpoint({breakpointId: id}));
      }
    }
    this._resolvedLocation = undefined;
    this._perThread.clear();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    await promises;
  }
};

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  private _initialized = false;
  _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;
  _sourceContainer: SourceContainer;
  _threadManager: ThreadManager;
  _disposables: vscode.Disposable[] = [];
  _perThread = new Map<number, Map<string, Breakpoint>>();

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver, sourceContainer: SourceContainer, threadManager: ThreadManager) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
    this._sourceContainer = sourceContainer;
    this._threadManager = threadManager;
  }

  async initialize(): Promise<void> {
    this._initialized = true;
    const promises: Promise<void>[] = [];
    for (const breakpoints of this._byPath.values())
      promises.push(...breakpoints.map(b => b.set(true)));

    const onThread = (thread: Thread) => {
      this._perThread.set(thread.threadId(), new Map());
      thread.cdp().Debugger.on('breakpointResolved', event => {
        const map = this._perThread.get(thread.threadId());
        const breakpoint = map ? map.get(event.breakpointId) : undefined;
        if (breakpoint)
          breakpoint.breakpointResolved(thread, event.breakpointId, [event.location]);
      });
    };
    this._threadManager.threads().forEach(onThread);
    this._threadManager.onThreadInitialized(onThread, undefined, this._disposables);
    this._threadManager.onThreadRemoved(thread => {
      this._perThread.delete(thread.threadId());
    }, undefined, this._disposables);

    this._threadManager.setScriptSourceMapHandler(async (script, sources) => {
      for (const source of sources) {
        const path = await source.absolutePath();
        const byPath = path ? this._byPath.get(path) : undefined;
        for (const breakpoint of byPath || [])
          breakpoint.updateForSourceMap(script);
        const byRef = this._byRef.get(source.sourceReference());
        for (const breakpoint of byRef || [])
          breakpoint.updateForSourceMap(script);
      }
    });

    await Promise.all(promises);
  }

  async setBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    const breakpoints: Breakpoint[] = (params.breakpoints || []).map(b => new Breakpoint(this, params.source, b));
    let previous: Breakpoint[] | undefined;
    if (params.source.path) {
      previous = this._byPath.get(params.source.path);
      this._byPath.set(params.source.path, breakpoints);
    } else {
      previous = this._byRef.get(params.source.sourceReference!);
      this._byRef.set(params.source.sourceReference!, breakpoints);
    }
    if (previous)
      await Promise.all(previous.map(b => b.remove()));
    if (this._initialized)
      await Promise.all(breakpoints.map(b => b.set(false)));
    return {breakpoints: await Promise.all(breakpoints.map(b => b.toDap()))};
  }
}

export const kLogPointUrl = 'logpoint.cdp';

function logMessageToExpression(msg: string): string {
  msg = msg.replace('%', '%%');

  const args: string[] = [];
  let format = msg.replace(/{(.*?)}/g, (match, group) => {
    const a = group.trim();
    if (a) {
      args.push(`(${a})`);
      return '%O';
    } else {
      return '';
    }
  });

  format = format.replace('\'', '\\\'');

  const argStr = args.length ? `, ${args.join(', ')}` : '';
  return `console.log('${format}'${argStr});\n//# sourceURL=${kLogPointUrl}`;
}