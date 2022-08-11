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

import { Span } from '@opentelemetry/api';
import { otperformance } from '@opentelemetry/core';
import {
  hasKey,
  PerformanceEntries,
  PerformanceLegacy,
  PerformanceTimingNames as PTN,
} from '@opentelemetry/sdk-trace-web';
import { getCLS, getFCP, getFID, getLCP, getTTFB, Metric } from 'web-vitals'
import { EventNames } from './enums/EventNames';

export const getPerformanceNavigationEntries = (): PerformanceEntries => {
  const entries: PerformanceEntries = {};
  const performanceNavigationTiming = (
    otperformance as unknown as Performance
  ).getEntriesByType?.('navigation')[0] as PerformanceEntries;

  if (performanceNavigationTiming) {
    const keys = Object.values(PTN);
    keys.forEach((key: string) => {
      if (hasKey(performanceNavigationTiming, key)) {
        const value = performanceNavigationTiming[key];
        if (typeof value === 'number') {
          entries[key] = value;
        }
      }
    });
  } else {
    // // fallback to previous version
    const perf: typeof otperformance & PerformanceLegacy = otperformance;
    const performanceTiming = perf.timing;
    if (performanceTiming) {
      const keys = Object.values(PTN);
      keys.forEach((key: string) => {
        if (hasKey(performanceTiming, key)) {
          const value = performanceTiming[key];
          if (typeof value === 'number') {
            entries[key] = value;
          }
        }
      });
    }
  }

  return entries;
};

const vitalsMetricNames: Record<Metric['name'], string> = {
  FCP: EventNames.FIRST_CONTENTFUL_PAINT,
  FID: EventNames.FIRST_INPUT_DELAY,
  TTFB: EventNames.TIME_TO_FIRST_BYTE,
  LCP: EventNames.LARGEST_CONTENTFUL_PAINT,
  CLS: EventNames.CUMULATIVE_LAYOUT_SHIFT
}

const performancePaintNames = {
  'first-paint': EventNames.FIRST_PAINT,
};

export const addSpanPerformancePaintEvents = (span: Span, callback: () => void) => {
  const missedMetrics: Set<Metric['name']> = new Set(['FCP', 'FID', 'TTFB'])
  if ('chrome' in globalThis) {
    missedMetrics.add('LCP')
    missedMetrics.add('CLS')
  }

  let spanIsEnded = false

  const endSpan = () => {
    document.removeEventListener('visibilitychange', endSpan)
    globalThis.removeEventListener('pagehide', endSpan)
    if (!spanIsEnded) {
      spanIsEnded = true
      callback()
    }
  }

  const handleNewMetric = (metric: Metric) => {
    missedMetrics.delete(metric.name)
    span.addEvent(vitalsMetricNames[metric.name], metric.value)
    if (!missedMetrics.size) {
      endSpan()
    }
  }

  document.addEventListener('visibilitychange', endSpan)
  globalThis.addEventListener('pagehide', endSpan)

  getCLS(handleNewMetric)
  getFCP(handleNewMetric)
  getFID(handleNewMetric)
  getLCP(handleNewMetric)
  getTTFB(handleNewMetric)

  const performancePaintTiming = (
    otperformance as unknown as Performance
  ).getEntriesByType?.('paint');
  if (performancePaintTiming) {
    performancePaintTiming.forEach(({ name, startTime }) => {
      if (hasKey(performancePaintNames, name)) {
        span.addEvent(performancePaintNames[name], startTime);
      }
    });
  }
};
