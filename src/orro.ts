import morphdom from "morphdom";
import { Browser, RealBrowser } from "./browser";
import { EventQueue } from "./event_queue";
import {
  EventConfig,
  KeyboardEventConfig,
  Logic,
  Msg,
  RustEventListener,
  RustInterval,
} from "./rust_types";

interface Config {
  appId: string;
  debug: boolean;
}

interface State {
  eventListeners: Map<string, EventHandler[]>;
  intervals: RunningInterval[];
}

class Orro {
  private readonly appElem: HTMLElement;
  private readonly browser: Browser;
  private readonly eventQueue: EventQueue = new EventQueue();
  private msgHandler: (msg: object) => void = (_msg) => {};

  private readonly state: State = {
    eventListeners: new Map(),
    intervals: [],
  };

  constructor(private config: Config) {
    const browser = new RealBrowser();
    const appElem = browser.getElementById(config.appId);
    if (!appElem) {
      throw new Error(`Could not find element with id #${config.appId}`);
    }

    this.appElem = appElem;
    this.browser = browser;
  }

  updateDom(markup: string) {
    const focusedElement = this.browser.getActiveElement();

    morphdom(this.appElem, markup, {
      onBeforeElUpdated(fromElem, toElem) {
        // Skip update of focused input element, this prevents resetting the input value while the user is typing.
        const inputIsFocused =
          fromElem.nodeName === "INPUT" &&
          toElem.nodeName === "INPUT" &&
          fromElem.isSameNode(focusedElement) &&
          (fromElem as HTMLInputElement).value !==
            (toElem as HTMLInputElement).value;

        if (inputIsFocused) {
          return false;
        }

        // Skip elements which has the unmanaged attribute
        const isUnmanaged = fromElem.hasAttribute("unmanaged");
        if (isUnmanaged) {
          return false;
        }

        return true;
      },
    });
  }

  initLogic(logic: Logic, msgHandler: (msg: Msg) => void) {
    const eventHandlers = this.prepareEventHandlers(logic.eventListeners);
    const intervals = logic.intervals.filter(this.isValidInterval);

    this.initEventHandlers(eventHandlers);
    const startedIntervals = intervals.map(this.startInterval);

    this.state.eventListeners = eventHandlers;
    this.state.intervals = startedIntervals;
    this.msgHandler = msgHandler;
  }

  updateLogic(logic: Logic) {
    this.updateEventListeners(logic.eventListeners);
    this.updateIntervals(logic.intervals);
  }

  private isValidInterval(interval: RustInterval): boolean {
    if (interval.duration < 100) {
      console.warn(
        "Ignoring interval with low duration: ${interval.duration}ms"
      );
      return false;
    }

    return true;
  }

  private startInterval(interval: RustInterval): RunningInterval {
    const intervalId = this.browser.setInterval(() => {
      this.queueUpdate({
        id: this.formatIntervalId(interval),
        strategy: interval.queueStrategy,
        msg: interval.msg,
      });
    }, interval.duration);

    return {
      id: intervalId,
      interval,
    };
  }

  private formatIntervalId(interval: RustInterval) {
    return `${interval.id}-${interval.msg}-${interval.duration}`;
  }

  private prepareEventHandlers(
    eventListeners: RustEventListener[]
  ): Map<string, EventHandler[]> {
    const eventHandlers: Map<string, EventHandler[]> = new Map();

    return eventListeners.reduce((acc, listener) => {
      const type = listener.event.type;

      if (!acc.has(type)) {
        acc.set(type, []);
      }

      acc.get(type)!.push({
        config: listener.event.config,
        id: listener.id,
        selector: listener.selector,
        msg: listener.msg,
        queueStrategy: listener.queueStrategy,
      });

      return acc;
    }, eventHandlers);
  }

  private updateEventListeners(eventListeners: RustEventListener[]) {
    const currentListeners = new Map(this.state.eventListeners);

    eventListeners.forEach((listener) => {
      this.removeEventListeners(currentListeners, listener.id);
    });

    // TODO: call document.addEventListener on new event types (onclick, etc)
    const handlers = this.prepareEventHandlers(eventListeners);
    this.addEventHandlers(currentListeners, handlers);

    this.state.eventListeners = currentListeners;
  }

  private addEventHandlers(
    currentListeners: Map<string, EventHandler[]>,
    eventListeners: Map<string, EventHandler[]>
  ) {
    eventListeners.forEach((handlers, eventName) => {
      const currentHandlers = currentListeners.get(eventName) || [];
      currentListeners.set(eventName, currentHandlers.concat(handlers));
    });
  }

  private removeEventListeners(
    currentListeners: Map<string, EventHandler[]>,
    id: string
  ) {
    currentListeners.forEach((handlers, eventName) => {
      const filteredHandlers = handlers.filter((handler) => {
        return handler.id !== id;
      });

      currentListeners.set(eventName, filteredHandlers);
    });
  }

  private updateIntervals(intervals: RustInterval[]) {
    const currentIntervals = this.state.intervals;

    const newIds = intervals.map(this.formatIntervalId);
    const currentIds = currentIntervals.map(({ interval }) =>
      this.formatIntervalId(interval)
    );

    // Stop intervals that does not exist anymore
    currentIntervals
      .filter(({ interval }) => {
        const id = this.formatIntervalId(interval);
        return !newIds.includes(id);
      })
      .forEach((interval) => {
        this.browser.clearInterval(interval.id);
      });

    // Get existing intervals that we want to keep
    const continuingIntervals = currentIntervals.filter(({ interval }) => {
      const id = this.formatIntervalId(interval);
      return newIds.includes(id);
    });

    // Start new intervals
    const newIntervals = intervals
      .filter((interval) => {
        const id = this.formatIntervalId(interval);
        return !currentIds.includes(id);
      })
      .map(this.startInterval);

    this.state.intervals = [...continuingIntervals, ...newIntervals];
  }

  private handleEvent(e: Event, eventName: string): void {
    const elem = e.target as Element;
    const handlers = this.state.eventListeners.get(eventName);

    if (this.config.debug) {
      console.debug("ORRO DEBUG", {
        functionName: "handleEvent",
        eventName,
        targetElement: elem,
      });
    }

    if (!handlers) {
      return;
    }

    handlers
      .filter((handler) => {
        return this.shouldHandleEvent(handler, elem);
      })
      .forEach((handler) => {
        const eventConfig = this.getEventConfig(handler.config);

        if (eventConfig.preventDefault) {
          e.preventDefault();
        }

        if (eventConfig.stopPropagation) {
          e.stopPropagation();
        }

        const msg = this.replaceMsgPlaceholder(handler.msg);

        this.queueUpdate({
          id: handler.selector,
          strategy: handler.queueStrategy,
          msg,
        });
      });
  }

  private shouldHandleEvent(handler: EventHandler, elem: Element): boolean {
    const eventConfig = this.getEventConfig(handler.config);

    if (eventConfig.matchParentElements) {
      return elem.closest(handler.selector) != null;
    } else {
      return elem.matches(handler.selector);
    }
  }

  private getEventConfig(
    config: EventConfig | KeyboardEventConfig
  ): EventConfig {
    if ("event" in config) {
      return config.event;
    }

    return config;
  }

  private replacePlaceholderValue(value: string) {
    if (value.startsWith("VALUE_FROM_ID:")) {
      const elemId = value.replace("VALUE_FROM_ID:", "");
      const elem = this.browser.getElementById(elemId) as HTMLInputElement;
      if (elem && elem.value) {
        return elem.value;
      }

      return "";
    }

    return value;
  }

  private replaceMsgPlaceholder(msg: Msg) {
    if (typeof msg !== "object") {
      return msg;
    }

    const entries = Object.entries(msg).map(([key, value]) => {
      const newValue = this.replacePlaceholderValue(value as string);
      return [key, newValue];
    });

    return Object.fromEntries(entries);
  }

  private queueUpdate({ id, strategy, msg }: Update) {
    const msgHandler = this.msgHandler;

    return this.eventQueue.enqueue({
      id,
      strategy,

      action() {
        if (!msg) {
          return;
        }

        msgHandler(msg);
      },
    });
  }

  private initEventHandlers(eventHandlers: Map<string, EventHandler[]>) {
    eventHandlers.forEach((_value, eventName) => {
      this.browser.addEventListener(
        eventName,
        (e) => {
          this.handleEvent(e, eventName);
        },
        true
      );
    });
  }
}

interface EventHandler {
  config: EventConfig | KeyboardEventConfig;
  id: string;
  selector: string;
  msg: Msg;
  queueStrategy: string;
}

interface RunningInterval {
  id: number;
  interval: RustInterval;
}

interface Update {
  id: string;
  strategy: string;
  msg: Msg;
}

export { Orro, Config };
