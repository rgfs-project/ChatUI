// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUMP_DISTANCE, PIN_THRESHOLD, useScrollPin } from "../../app/lib/use-scroll-pin";

/** jsdom has no layout: drive a fake scroll box by hand. */
interface Box {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrolls: number;
}
let box: Box;

function Harness({ version }: { version: number }) {
  const { ref, handlers, showJump, jumpToLatest } = useScrollPin<HTMLDivElement>(version);
  return (
    <>
      <div
        data-testid="box"
        {...handlers}
        ref={(el) => {
          ref.current = el;
          if (!el) return;
          Object.defineProperty(el, "scrollHeight", {
            configurable: true,
            get: () => box.scrollHeight,
          });
          Object.defineProperty(el, "clientHeight", {
            configurable: true,
            get: () => box.clientHeight,
          });
          Object.defineProperty(el, "scrollTop", {
            configurable: true,
            get: () => box.scrollTop,
            set: (v: number) => {
              box.scrollTop = v;
            },
          });
          el.scrollTo = ((opts: ScrollToOptions) => {
            box.scrolls++;
            box.scrollTop = Math.max(0, (opts.top ?? 0) - box.clientHeight);
          }) as typeof el.scrollTo;
        }}
      />
      {showJump ? (
        <button type="button" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </>
  );
}

/** The programmatic flag clears on the next animation frame. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(undefined);
      });
    });
  });
}

function userScrollTo(top: number) {
  box.scrollTop = top;
  fireEvent.scroll(screen.getByTestId("box"));
}

beforeEach(() => {
  box = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0, scrolls: 0 };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("scroll intent", () => {
  it("follows new content while pinned to the bottom", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    expect(box.scrollTop).toBe(600);
    box.scrollHeight = 1400;
    rerender(<Harness version={1} />);
    await frame();
    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("a user scroll away from the bottom unpins; new content does not move the viewport", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    userScrollTo(100);
    const before = box.scrolls;
    box.scrollHeight = 1600;
    rerender(<Harness version={1} />);
    await frame();
    expect(box.scrollTop).toBe(100);
    expect(box.scrolls).toBe(before);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("scrolling within the threshold of the bottom still counts as pinned", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    userScrollTo(600 - PIN_THRESHOLD + 1);
    box.scrollHeight = 1200;
    rerender(<Harness version={1} />);
    await frame();
    expect(box.scrollTop).toBe(800);
  });

  it("programmatic scrolls and content growth never count as user intent", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    // Content grows and a scroll event arrives before we follow: not user intent.
    box.scrollHeight = 5000;
    fireEvent.scroll(screen.getByTestId("box"));
    rerender(<Harness version={1} />);
    await frame();
    expect(box.scrollTop).toBe(4600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("an upward wheel unpins at once, even before any scroll event (fast streams)", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    fireEvent.wheel(screen.getByTestId("box"), { deltaY: -40 });
    box.scrollHeight = 1400;
    rerender(<Harness version={1} />);
    expect(box.scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("upward navigation keys and touch drags unpin; a downward wheel does not", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    fireEvent.wheel(screen.getByTestId("box"), { deltaY: 40 });
    box.scrollHeight = 1200;
    rerender(<Harness version={1} />);
    expect(box.scrollTop).toBe(800);
    fireEvent.keyDown(screen.getByTestId("box"), { key: "PageUp" });
    box.scrollHeight = 1400;
    rerender(<Harness version={2} />);
    expect(box.scrollTop).toBe(800);
    userScrollTo(1000);
    fireEvent.touchMove(screen.getByTestId("box"));
    box.scrollHeight = 1600;
    rerender(<Harness version={3} />);
    expect(box.scrollTop).toBe(1000);
  });

  it("nothing to scroll: an upward wheel does not unpin", async () => {
    box.scrollHeight = 300;
    const { rerender } = render(<Harness version={0} />);
    await frame();
    fireEvent.wheel(screen.getByTestId("box"), { deltaY: -40 });
    box.scrollHeight = 900;
    rerender(<Harness version={1} />);
    expect(box.scrollTop).toBe(500);
  });

  it("a viewport resize (on-screen keyboard closing) clamps the scroll down but never unpins", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    // Keyboard open: the container shrank and the pin was kept at the bottom.
    box.clientHeight = 200;
    box.scrollTop = 800;
    // Keyboard closes: the container grows; the browser clamps scrollTop down
    // and fires a scroll event. Upward movement, yet still at the bottom.
    box.clientHeight = 400;
    userScrollTo(600);
    box.scrollHeight = 1300;
    rerender(<Harness version={1} />);
    await frame();
    expect(box.scrollTop).toBe(900);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("jump to latest re-pins and hides itself", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    userScrollTo(0);
    box.scrollHeight = 2000;
    rerender(<Harness version={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    await frame();
    expect(box.scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    box.scrollHeight = 2400;
    rerender(<Harness version={2} />);
    await frame();
    expect(box.scrollTop).toBe(2000);
  });

  it("scrolling back to the bottom by hand re-pins", async () => {
    const { rerender } = render(<Harness version={0} />);
    await frame();
    userScrollTo(0);
    box.scrollHeight = 1200;
    rerender(<Harness version={1} />);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
    userScrollTo(800);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("offers jump to latest once well away from the bottom, even with nothing new", async () => {
    box.scrollHeight = 2000;
    render(<Harness version={0} />);
    await frame();
    // A short look up (past the pin threshold, not past the jump distance): no button.
    userScrollTo(1600 - JUMP_DISTANCE + 10);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    // Further up: the button appears without any new content.
    userScrollTo(600);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    await frame();
    expect(box.scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});
