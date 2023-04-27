/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  context,
  propagation,
  trace,
  Span,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { otperformance, TRACE_PARENT_HEADER } from '@opentelemetry/core';
import {
  addSpanNetworkEvent,
  addSpanNetworkEvents,
  hasKey,
  PerformanceEntries,
  PerformanceTimingNames as PTN,
} from '@opentelemetry/sdk-trace-web';
import {
  InstrumentationBase,
  InstrumentationConfig,
} from '@opentelemetry/instrumentation';
import { AttributeNames } from './enums/AttributeNames';
import { VERSION } from './version';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import {
  addSpanPerformancePaintEvents,
  getPerformanceNavigationEntries,
} from './utils';

/**
 * This class represents a document load plugin
 */
export class DocumentLoadInstrumentation extends InstrumentationBase<unknown> {
  readonly component: string = 'document-load';
  readonly version: string = '1';
  moduleName = this.component;
  protected _config!: InstrumentationConfig;
  private _enabled = false;

  /**
   *
   * @param config
   */
  constructor(config: InstrumentationConfig = {}) {
    super('@opentelemetry/instrumentation-document-load', VERSION, config);
  }

  init() {}

  /**
   * callback to be executed when page is loaded
   */
  private _onDocumentLoaded() {
    // Timeout is needed as load event doesn't have yet the performance metrics for loadEnd.
    // Support for event "loadend" is very limited and cannot be used
    // @ts-ignore
    window.logOnScreen('instrumentation.ts:71 - _onDocumentLoaded() - call');
    window.setTimeout(() => {
      this._increasePerformanceBufferSize();
      this._collectPerformance();
    });
  }

  /**
   * Adds spans for all resources
   * @param rootSpan
   */
  private _addResourcesSpans(rootSpan: Span): void {
    const resources: PerformanceResourceTiming[] = (
      otperformance as unknown as Performance
    ).getEntriesByType?.('resource') as PerformanceResourceTiming[];
    if (resources) {
      resources.forEach(resource => {
        this._initResourceSpan(resource, rootSpan);
      });
    }
  }

  /**
   * Browsers set the default Performance API buffer size to 250 or greater (it's 250 on Chrome 107).
   * Some websites may load more scripts, so we need to increase buffer size limit dynamically.
   */
  private _increasePerformanceBufferSize() {
    const increaseBufferSize = () => {
      otperformance.setResourceTimingBufferSize(otperformance.getEntries().length + 500);
    }
    otperformance.addEventListener('resourcetimingbufferfull', increaseBufferSize);
  }

  /**
   * Collects information about performance and creates appropriate spans
   */
  private _collectPerformance() {
    const metaElement = Array.from(document.getElementsByTagName('meta')).find(
      e => e.getAttribute('name') === TRACE_PARENT_HEADER
    );
    const entries = getPerformanceNavigationEntries();
    // @ts-ignore
    window.logOnScreen('instrumentation.ts:113 - _collectPerformance() - call - entries: ', JSON.stringify(entries));
    const traceparent = (metaElement && metaElement.content) || '';
    context.with(propagation.extract(ROOT_CONTEXT, { traceparent }), () => {
      const rootSpan = this._startSpan(
        AttributeNames.DOCUMENT_LOAD,
        PTN.FETCH_START,
        entries
      );
      if (!rootSpan) {
        return;
      }
      context.with(trace.setSpan(context.active(), rootSpan), () => {
        const fetchSpan = this._startSpan(
          AttributeNames.DOCUMENT_FETCH,
          PTN.FETCH_START,
          entries
        );
        if (fetchSpan) {
          fetchSpan.setAttribute(SemanticAttributes.HTTP_URL, location.href);
          fetchSpan.setAttribute(SemanticAttributes.HTTP_USER_AGENT, navigator.userAgent);
          context.with(trace.setSpan(context.active(), fetchSpan), () => {
            addSpanNetworkEvents(fetchSpan, entries);
            this._endSpan(fetchSpan, PTN.RESPONSE_END, entries);
          });
        }
      });

      rootSpan.setAttribute(SemanticAttributes.HTTP_URL, location.href);
      rootSpan.setAttribute(
        SemanticAttributes.HTTP_USER_AGENT,
        navigator.userAgent
      );
      rootSpan.setAttribute(AttributeNames.PAGE_TITLE, document.title);

      this._addResourcesSpans(rootSpan);

      addSpanNetworkEvent(rootSpan, PTN.FETCH_START, entries);
      addSpanNetworkEvent(rootSpan, PTN.UNLOAD_EVENT_START, entries);
      addSpanNetworkEvent(rootSpan, PTN.UNLOAD_EVENT_END, entries);
      addSpanNetworkEvent(rootSpan, PTN.DOM_INTERACTIVE, entries);
      addSpanNetworkEvent(
        rootSpan,
        PTN.DOM_CONTENT_LOADED_EVENT_START,
        entries
      );
      addSpanNetworkEvent(rootSpan, PTN.DOM_CONTENT_LOADED_EVENT_END, entries);
      addSpanNetworkEvent(rootSpan, PTN.DOM_COMPLETE, entries);
      addSpanNetworkEvent(rootSpan, PTN.LOAD_EVENT_START, entries);
      addSpanNetworkEvent(rootSpan, PTN.LOAD_EVENT_END, entries);

      addSpanPerformancePaintEvents(rootSpan, () => {
        this._endSpan(rootSpan, PTN.LOAD_EVENT_END, entries);
      });
    });
  }

  /**
   * Helper function for ending span
   * @param span
   * @param performanceName name of performance entry for time end
   * @param entries
   */
  private _endSpan(
    span: Span | undefined,
    performanceName: string,
    entries: PerformanceEntries
  ) {
    // span can be undefined when entries are missing the certain performance - the span will not be created
    if (span) {
      if (performanceName === PTN.LOAD_EVENT_END) {
        // @ts-ignore
        window.logOnScreen('instrumentation.ts:184 - _endSpan() - call - performanceName: ', performanceName, 'time:', entries[performanceName], 'hasKey(entries, performanceName):', hasKey(entries, performanceName), 'entries:', JSON.stringify(entries));
      }
      span.setAttribute(`performanceEntries.${performanceName}`, JSON.stringify(entries));
      if (hasKey(entries, performanceName)) {
        span.end(entries[performanceName]);
      } else {
        // just end span
        span.end();
      }
    }
  }

  /**
   * Creates and ends a span with network information about resource added as timed events
   * @param resource
   * @param parentSpan
   */
  private _initResourceSpan(
    resource: PerformanceResourceTiming,
    parentSpan: Span
  ) {
    const span = this._startSpan(
      AttributeNames.RESOURCE_FETCH,
      PTN.FETCH_START,
      resource,
      parentSpan
    );
    if (span) {
      span.setAttribute(SemanticAttributes.HTTP_URL, resource.name);
      addSpanNetworkEvents(span, resource);
      this._endSpan(span, PTN.RESPONSE_END, resource);
    }
  }

  /**
   * Helper function for starting a span
   * @param spanName name of span
   * @param performanceName name of performance entry for time start
   * @param entries
   * @param parentSpan
   */
  private _startSpan(
    spanName: string,
    performanceName: string,
    entries: PerformanceEntries,
    parentSpan?: Span
  ): Span | undefined {
    if (
      hasKey(entries, performanceName) &&
      typeof entries[performanceName] === 'number'
    ) {
      const span = this.tracer.startSpan(
        spanName,
        {
          startTime: entries[performanceName],
        },
        parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined
      );
      span.setAttribute(AttributeNames.COMPONENT, this.component);
      if (Number.isNaN(entries[performanceName])) {
        span.setAttribute('wrongPerformanceEntryValue', performanceName);
      }
      if (spanName === AttributeNames.DOCUMENT_LOAD) {
        // @ts-ignore
        window.logOnScreen('instrumentation.ts:248 - _startSpan() - call - documentLoad - startTime:', entries[performanceName], 'entries:', JSON.stringify(entries));
      }
      return span;
    }
    return undefined;
  }

  /**
   * executes callback {_onDocumentLoaded} when the page is loaded
   */
  private _waitForPageLoad() {
    if (window.document.readyState === 'complete' && !this._enabled) {
      this._enabled = true;
      this._onDocumentLoaded();
      // @ts-ignore
      window.logOnScreen('instrumentation.ts:263 - _waitForPageLoad() - if', 'window.document.readyState:', window.document.readyState);
    } else {
      this._onDocumentLoaded = this._onDocumentLoaded.bind(this);
      window.addEventListener('load', this._onDocumentLoaded);
      // @ts-ignore
      window.logOnScreen('instrumentation.ts:268 - _waitForPageLoad() - else', 'window.document.readyState:', window.document.readyState);
    }
  }

  /**
   * implements enable function
   */
  override enable() {
    // @ts-ignore
    window.logOnScreen = (...args: string[]) => {
      // const messages = [Date.now(), new Date().toLocaleString(), performance.now(), ...args];
      // const div = document.createElement('div');
      // div.style.background = 'lightcyan';
      // div.style.marginBottom = '3px';
      // div.style.wordWrap = 'break-word';
      // div.innerHTML = `<strong>${messages.join(' ')}</strong>`;
      // document.body.prepend(div);
    }
    // remove previously attached load to avoid adding the same event twice
    // in case of multiple enable calling.
    // @ts-ignore
    window.logOnScreen('instrumentation.ts:291 - enable() - enable documentLoad span instrumentation');
    window.removeEventListener('load', this._onDocumentLoaded);
    this._waitForPageLoad();
  }

  /**
   * implements disable function
   */
  override disable() {
    window.removeEventListener('load', this._onDocumentLoaded);
  }
}
