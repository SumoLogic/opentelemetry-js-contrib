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

import { isWrapped, InstrumentationBase } from '@opentelemetry/instrumentation';

import * as api from '@opentelemetry/api';
import { hrTime } from '@opentelemetry/core';
import { getElementXPath } from '@opentelemetry/sdk-trace-web';
import { AttributeNames } from './enums/AttributeNames';
import {
  EventName,
  ShouldPreventSpanCreation,
  SpanData,
  UserInteractionInstrumentationConfig,
} from './types';
import { VERSION } from './version';

const EVENT_NAVIGATION_NAME = 'Navigation:';
const NEW_LOCATION_HREF = 'new.location.href';
const DEFAULT_EVENT_NAMES: EventName[] = ['click'];

function defaultShouldPreventSpanCreation() {
  return false;
}

const getCurrentLocation = () => `${location.pathname}${location.search}${location.hash}`;

/**
 * This class represents a UserInteraction plugin for auto instrumentation.
 * It patches addEventListener of HTMLElement.
 */
export class UserInteractionInstrumentation extends InstrumentationBase<unknown> {
  readonly component: string = 'user-interaction';
  readonly version = VERSION;
  moduleName = this.component;
  private _spansData = new WeakMap<api.Span, SpanData>();
  private _isEnabled = false
  // for addEventListener/removeEventListener state
  private _wrappedListeners = new WeakMap<
    Function | EventListenerObject,
    Map<string, Map<HTMLElement, Function>>
  >();
  // for event bubbling
  private _eventsSpanMap: WeakMap<Event, api.Span> = new WeakMap<
    Event,
    api.Span
  >();
  private _eventNames: Set<EventName>;
  private _shouldPreventSpanCreation: ShouldPreventSpanCreation;

  constructor(config?: UserInteractionInstrumentationConfig) {
    super('@opentelemetry/instrumentation-user-interaction', VERSION, config);
    this._eventNames = new Set(config?.eventNames ?? DEFAULT_EVENT_NAMES);
    this._shouldPreventSpanCreation =
      typeof config?.shouldPreventSpanCreation === 'function'
        ? config.shouldPreventSpanCreation
        : defaultShouldPreventSpanCreation;
  }

  init() {}

  /**
   * Controls whether or not to create a span, based on the event type.
   */
  protected _allowEventName(eventName: EventName): boolean {
    return this._eventNames.has(eventName);
  }

  /**
   * Creates a new span
   * @param element
   * @param eventName
   */
  private _createSpan(
    element: EventTarget | null | undefined,
    eventName: EventName,
  ): api.Span | undefined {
    if (!(element instanceof HTMLElement)) {
      return undefined;
    }
    if (!element.getAttribute) {
      return undefined;
    }
    if (element.hasAttribute('disabled')) {
      return undefined;
    }
    if (!this._allowEventName(eventName)) {
      return undefined;
    }
    const xpath = getElementXPath(element, true);
    try {
      const span = this.tracer.startSpan(
        eventName,
        {
          attributes: {
            [AttributeNames.COMPONENT]: this.component,
            [AttributeNames.EVENT_TYPE]: eventName,
            [AttributeNames.TARGET_ELEMENT]: element.tagName,
            [AttributeNames.TARGET_XPATH]: xpath,
            [AttributeNames.HTTP_URL]: window.location.href,
            [AttributeNames.HTTP_USER_AGENT]: navigator.userAgent,
          },
        },
        api.ROOT_CONTEXT
      );

      if (this._shouldPreventSpanCreation(eventName, element, span) === true) {
        return undefined;
      }

      this._spansData.set(span, {
        taskCount: 0,
      });

      return span;
    } catch (e) {
      api.diag.error(this.component, e);
    }
    return undefined;
  }

  /**
   * Returns true if we should use the patched callback; false if it's already been patched
   */
  private addPatchedListener(
    on: HTMLElement,
    type: string,
    listener: Function | EventListenerObject,
    wrappedListener: Function
  ): boolean {
    let listener2Type = this._wrappedListeners.get(listener);
    if (!listener2Type) {
      listener2Type = new Map();
      this._wrappedListeners.set(listener, listener2Type);
    }
    let element2patched = listener2Type.get(type);
    if (!element2patched) {
      element2patched = new Map();
      listener2Type.set(type, element2patched);
    }
    if (element2patched.has(on)) {
      return false;
    }
    element2patched.set(on, wrappedListener);
    return true;
  }

  /**
   * Returns the patched version of the callback (or undefined)
   */
  private removePatchedListener(
    on: HTMLElement,
    type: string,
    listener: Function | EventListenerObject
  ): Function | undefined {
    const listener2Type = this._wrappedListeners.get(listener);
    if (!listener2Type) {
      return undefined;
    }
    const element2patched = listener2Type.get(type);
    if (!element2patched) {
      return undefined;
    }
    const patched = element2patched.get(on);
    if (patched) {
      element2patched.delete(on);
      if (element2patched.size === 0) {
        listener2Type.delete(type);
        if (listener2Type.size === 0) {
          this._wrappedListeners.delete(listener);
        }
      }
    }
    return patched;
  }

  // utility method to deal with the Function|EventListener nature of addEventListener
  private _invokeListener(
    listener: Function | EventListenerObject,
    target: any,
    args: any[]
  ): any {
    if (typeof listener === 'function') {
      return listener.apply(target, args);
    } else {
      return listener.handleEvent(args[0]);
    }
  }

  /**
   * This patches the addEventListener of HTMLElement to be able to
   * auto instrument the click events
   */
  private _patchAddEventListener() {
    const plugin = this;
    return (original: EventTarget['addEventListener']) => {
      return function addEventListenerPatched(
        this: HTMLElement,
        type: keyof HTMLElementEventMap,
        listener: EventListenerOrEventListenerObject | null,
        useCapture?: boolean | AddEventListenerOptions
      ) {
        // Forward calls with listener = null
        if (!listener) {
          return original.call(this, type, listener, useCapture);
        }

        // filter out null (typeof null === 'object')
        const once =
          useCapture && typeof useCapture === 'object' && useCapture.once;
        const addEventListenerContext = this
        const patchedListener = function (this: HTMLElement, ...args: any[]) {
          const event: Event | undefined = args[0];
          const target = event?.target;
          if (once) {
            plugin.removePatchedListener(addEventListenerContext, type, listener);
          }
          // use previously created span for this event in order to create one span per event
          const eventSpan = event && plugin._eventsSpanMap.get(event)
          const span = eventSpan || plugin._createSpan(target, type);
          if (span) {
            if (event && !eventSpan) {
              plugin._eventsSpanMap.set(event, span);
            }

            const spansData = plugin._spansData.get(span)!
            const result = api.context.with(
              api.trace.setSpan(api.context.active(), span),
              () => {
                if (spansData.currentLocation === undefined) {
                  // set `currentLocation` only once for this event
                  spansData.currentLocation = getCurrentLocation();
                }
                const result = plugin._invokeListener(listener, this, args);
                spansData.lastListenerEndHrTime = hrTime();
                return result;
              }
            );
            if (event && !eventSpan) {
              // end span when all other listeners end and wait 100ms for possible navigation change
              setTimeout(() => {
                if (spansData.currentLocation !== getCurrentLocation()) {
                  plugin._updateSpanAsNavigation(span);
                }
                span.end(spansData.lastListenerEndHrTime)
              }, 200)
            }
            return result;
          }

          if (event instanceof UIEvent && event.isTrusted) {
            // if there is no event span, we still don't want to attach this operator to the previous span,
            // because it's a user interaction event
            return api.context.with(api.ROOT_CONTEXT, () => plugin._invokeListener(listener, this, args));
          }

          return plugin._invokeListener(listener, this, args);
        };
        if (plugin.addPatchedListener(this, type, listener, patchedListener)) {
          return original.call(this, type, patchedListener, useCapture);
        }
      };
    };
  }

  /**
   * This patches the removeEventListener of HTMLElement to handle the fact that
   * we patched the original callbacks
   */
  private _patchRemoveEventListener() {
    const plugin = this;
    return (original: Function) => {
      return function removeEventListenerPatched(
        this: HTMLElement,
        type: any,
        listener: any,
        useCapture: any
      ) {
        const wrappedListener = plugin.removePatchedListener(
          this,
          type,
          listener
        );
        if (wrappedListener) {
          return original.call(this, type, wrappedListener, useCapture);
        } else {
          return original.call(this, type, listener, useCapture);
        }
      };
    };
  }

  /**
   * Most browser provide event listener api via EventTarget in prototype chain.
   * Exception to this is IE 11 which has it on the prototypes closest to EventTarget:
   *
   * * - has addEventListener in IE
   * ** - has addEventListener in all other browsers
   * ! - missing in IE
   *
   * HTMLElement -> Element -> Node * -> EventTarget **! -> Object
   * Document -> Node * -> EventTarget **! -> Object
   * Window * -> WindowProperties ! -> EventTarget **! -> Object
   */
  private _getPatchableEventTargets(): EventTarget[] {
    return window.EventTarget
      ? [EventTarget.prototype]
      : [Node.prototype, Window.prototype];
  }

  /**
   * Updates interaction span name
   * @param url
   */
  _updateSpanAsNavigation(span: api.Span) {
    span.updateName(`${EVENT_NAVIGATION_NAME} ${getCurrentLocation()}`);
    span.setAttribute(NEW_LOCATION_HREF, location.href);
  }

  /**
   * implements enable function
   */
  override enable() {
    if (this._isEnabled) return
    this._isEnabled = true
    api.diag.debug(
      'applying patch to',
      this.moduleName,
      this.version,
    );

    const targets = this._getPatchableEventTargets();
    targets.forEach(target => {
      this._wrap(target, 'addEventListener', this._patchAddEventListener());
      this._wrap(
        target,
        'removeEventListener',
        this._patchRemoveEventListener()
      );
    });
  }

  /**
   * implements unpatch function
   */
  override disable() {
    if (!this._isEnabled) return
    this._isEnabled = false
    api.diag.debug(
      'removing patch from',
      this.moduleName,
      this.version,
    );
    const targets = this._getPatchableEventTargets();
    targets.forEach(target => {
      if (isWrapped(target.addEventListener)) {
        this._unwrap(target, 'addEventListener');
      }
      if (isWrapped(target.removeEventListener)) {
        this._unwrap(target, 'removeEventListener');
      }
    });
  }
}
