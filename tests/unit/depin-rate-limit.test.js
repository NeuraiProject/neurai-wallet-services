const { createDepinLimiter, resolveDepinConfig, isDepinMethod } = require("../../depinRateLimit");

describe("depin rate limiter: per key, sliding minute, temporary ban", () => {
  test("allows up to the limit, then bans for banMinutes", () => {
    const limiter = createDepinLimiter({ perMinute: 3, banMinutes: 60 });
    const t0 = 1_000_000;
    expect(limiter.check("ip", t0).allowed).toBe(true);
    expect(limiter.check("ip", t0 + 1000).allowed).toBe(true);
    expect(limiter.check("ip", t0 + 2000).allowed).toBe(true);
    const fourth = limiter.check("ip", t0 + 3000);
    expect(fourth).toEqual({ allowed: false, banned: true, justBanned: true, retryAfterSeconds: 3600 });
    // Banned for the whole hour from the banning request, with a shrinking Retry-After.
    expect(limiter.check("ip", t0 + 3000 + 30 * 60 * 1000)).toEqual({ allowed: false, banned: true, retryAfterSeconds: 1800 });
    expect(limiter.stats()).toEqual({ per_minute: 3, ban_minutes: 60, tracked: 0, banned: 1 });
    // After the ban lapses the counter starts from zero.
    expect(limiter.check("ip", t0 + 3000 + 60 * 60 * 1000).allowed).toBe(true);
    expect(limiter.stats().banned).toBe(0);
  });

  test("the window slides: old hits stop counting after a minute", () => {
    // banMinutes 0 so a refusal does not turn into a ban and hide the window.
    const limiter = createDepinLimiter({ perMinute: 2, banMinutes: 0 });
    const t0 = 5_000_000;
    limiter.check("ip", t0);
    limiter.check("ip", t0 + 100);
    // t0 has left the window; t0+100 has not yet.
    expect(limiter.check("ip", t0 + 60_001).allowed).toBe(true);
    expect(limiter.check("ip", t0 + 60_050).allowed).toBe(false);
    // Now t0+100 is gone too: one hit (t0+60_001) remains in the window.
    expect(limiter.check("ip", t0 + 60_101).allowed).toBe(true);
    expect(limiter.check("ip", t0 + 60_110).allowed).toBe(false);
  });

  test("keys are independent", () => {
    const limiter = createDepinLimiter({ perMinute: 1, banMinutes: 1 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(false);
    expect(limiter.check("b", 1).allowed).toBe(false);
    expect(limiter.stats().banned).toBe(2);
  });

  test("banMinutes = 0 refuses until the window frees instead of banning", () => {
    const limiter = createDepinLimiter({ perMinute: 1, banMinutes: 0 });
    expect(limiter.check("ip", 0).allowed).toBe(true);
    expect(limiter.check("ip", 10_000)).toEqual({ allowed: false, banned: false, retryAfterSeconds: 50 });
    expect(limiter.check("ip", 60_001).allowed).toBe(true);
  });

  test("perMinute = 0 disables the limiter", () => {
    const limiter = createDepinLimiter({ perMinute: 0, banMinutes: 60 });
    for (let i = 0; i < 100; i++) expect(limiter.check("ip", i).allowed).toBe(true);
    expect(limiter.stats().tracked).toBe(0);
  });

  test("prune drops stale hits and expired bans, and the map stays bounded", () => {
    const limiter = createDepinLimiter({ perMinute: 5, banMinutes: 1, maxKeys: 10 });
    for (let i = 0; i < 10; i++) limiter.check(`ip${i}`, 0);
    expect(limiter.stats().tracked).toBe(10);
    limiter.check("ip-new", 1);
    expect(limiter.stats().tracked).toBe(10);
    limiter.prune(61_000);
    expect(limiter.stats().tracked).toBe(0);
  });
});

describe("depin config section", () => {
  test("defaults and validation", () => {
    expect(resolveDepinConfig(null)).toEqual({ rate_limit: 60, ban_minutes: 10 });
    expect(resolveDepinConfig({})).toEqual({ rate_limit: 60, ban_minutes: 10 });
    expect(resolveDepinConfig({ depin: { rate_limit: 0, ban_minutes: 0 } })).toEqual({ rate_limit: 0, ban_minutes: 0 });
    expect(() => resolveDepinConfig({ depin: { rate_limit: -1 } })).toThrow("depin.rate_limit");
    expect(() => resolveDepinConfig({ depin: { ban_minutes: 1.5 } })).toThrow("depin.ban_minutes");
    expect(() => resolveDepinConfig({ depin: { rate_limit: "60" } })).toThrow("depin.rate_limit");
    expect(() => resolveDepinConfig({ depin: [] })).toThrow("depin must be an object");
  });

  test("only RPC names starting with depin count", () => {
    expect(isDepinMethod("depinchallenge")).toBe(true);
    expect(isDepinMethod("depingetancestorrecipients")).toBe(true);
    expect(isDepinMethod("checkdepinvalidity")).toBe(false);
    expect(isDepinMethod("listdepinholders")).toBe(false);
    expect(isDepinMethod(undefined)).toBe(false);
  });
});
