import { describe, expect, it } from "vitest";
import { PIN_THRESHOLD_PX, scrollIntent, type ScrollMetrics } from "../../app/chat/scroll-intent";

const at = (scrollTop: number): ScrollMetrics => ({
  scrollTop,
  scrollHeight: 2_000,
  clientHeight: 500,
});
const BOTTOM = 1_500;

describe("scroll intent (pin / unpin / jump to latest)", () => {
  it("starts pinned and follows growth while pinned", () => {
    const s = scrollIntent.initial();
    expect(s.pinned).toBe(true);
    expect(scrollIntent.onGrowth(s).follow).toBe(true);
  });

  it("a user scroll away from the bottom unpins; growth then neither follows nor moves", () => {
    const up = scrollIntent.onScroll(scrollIntent.initial(), at(BOTTOM - 400), false);
    expect(up.pinned).toBe(false);
    const grown = scrollIntent.onGrowth(up);
    expect(grown.follow).toBe(false);
    expect(grown.state.hasNew).toBe(true);
  });

  it("programmatic scrolls never count as user intent", () => {
    const s = scrollIntent.initial();
    expect(scrollIntent.onScroll(s, at(0), true)).toBe(s);
    const up = scrollIntent.onScroll(s, at(0), false);
    expect(scrollIntent.onScroll(up, at(BOTTOM), true)).toBe(up);
  });

  it("returning within the threshold re-pins and clears the new-content flag", () => {
    const up = scrollIntent.onGrowth(
      scrollIntent.onScroll(scrollIntent.initial(), at(0), false),
    ).state;
    const back = scrollIntent.onScroll(up, at(BOTTOM - PIN_THRESHOLD_PX), false);
    expect(back).toEqual({ pinned: true, hasNew: false });
  });

  it("jump to latest re-pins", () => {
    expect(scrollIntent.onJump()).toEqual({ pinned: true, hasNew: false });
  });
});
