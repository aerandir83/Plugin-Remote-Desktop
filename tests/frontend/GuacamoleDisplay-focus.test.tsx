import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Keyboard capture only attaches once the display has focus, so the display
// must take focus when the session reaches CONNECTED.
const mocks = vi.hoisted(() => {
  const state = {
    client: null as null | {
      sendSize: ReturnType<typeof vi.fn>;
      element: HTMLElement;
      onstatechange: ((state: number) => void) | null;
    },
  };
  return state;
});

vi.mock("guacamole-common-js", () => {
  class Client {
    sendSize = vi.fn();
    onstatechange: ((state: number) => void) | null = null;
    element = document.createElement("div");
    constructor() {
      mocks.client = this;
    }
    getDisplay() {
      return {
        getElement: () => this.element,
        getWidth: () => 1280,
        getHeight: () => 720,
        scale: vi.fn(),
        onresize: null,
      };
    }
    connect() {}
    disconnect() {}
  }
  class Keyboard {
    onkeydown: unknown = null;
    onkeyup: unknown = null;
    reset() {}
  }
  class Mouse {
    static State = class {};
    static Touchscreen = class {};
    static Touchpad = class {};
  }
  const Status = { Code: { SUCCESS: 0 } };
  return {
    default: {
      Client,
      Keyboard,
      Mouse,
      Status,
      WebSocketTunnel: class {},
    },
  };
});

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: () => false,
  getBasePath: () => "",
  resolveConnectionOrigin: async () => "remote",
}));

import { GuacamoleDisplay } from "../../src/frontend/GuacamoleDisplay";

class FakeResizeObserver {
  constructor(_callback: () => void) {}
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  mocks.client = null;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1024,
    height: 768,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 768,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const config = { protocol: "vnc" as const, token: "test-token" };

async function renderDisplay() {
  const view = render(<GuacamoleDisplay connectionConfig={config} isVisible />);
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  const client = mocks.client!;
  const focus = vi.spyOn(client.element, "focus");
  return { client, focus, view };
}

describe("GuacamoleDisplay focus on connect", () => {
  it("focuses the display when the session connects", async () => {
    const { client, focus } = await renderDisplay();

    act(() => client.onstatechange?.(3)); // CONNECTED

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not take focus while the tab is hidden", async () => {
    const { client, focus, view } = await renderDisplay();
    view.rerender(
      <GuacamoleDisplay connectionConfig={config} isVisible={false} />,
    );

    act(() => client.onstatechange?.(3));

    expect(focus).not.toHaveBeenCalled();
  });

  it("does not take focus while the window is unfocused", async () => {
    const { client, focus } = await renderDisplay();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("blur")));

    act(() => client.onstatechange?.(3));

    expect(focus).not.toHaveBeenCalled();
  });
});
