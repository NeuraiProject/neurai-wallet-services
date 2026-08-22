const { clientIp, resolveTrustedProxies, DEFAULT_TRUSTED_PROXY_IPS } = require("../../clientIp");

function req(remote, forwarded) {
  return { socket: { remoteAddress: remote }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} };
}

test("trusted_proxy_ips: root setting, legacy http setting, default", () => {
  expect(resolveTrustedProxies(null)).toEqual(new Set(DEFAULT_TRUSTED_PROXY_IPS));
  expect(resolveTrustedProxies({})).toEqual(new Set(DEFAULT_TRUSTED_PROXY_IPS));
  expect(resolveTrustedProxies({ trusted_proxy_ips: ["172.19.0.1"] })).toEqual(new Set(["172.19.0.1"]));
  expect(resolveTrustedProxies({ http: { trusted_proxy_ips: ["10.0.0.1"] } })).toEqual(new Set(["10.0.0.1"]));
  expect(resolveTrustedProxies({ trusted_proxy_ips: ["172.19.0.1"], http: { trusted_proxy_ips: ["10.0.0.1"] } })).toEqual(new Set(["172.19.0.1"]));
  expect(resolveTrustedProxies({ trusted_proxy_ips: [] })).toEqual(new Set());
  expect(() => resolveTrustedProxies({ trusted_proxy_ips: "127.0.0.1" })).toThrow("trusted_proxy_ips");
  expect(() => resolveTrustedProxies({ trusted_proxy_ips: [""] })).toThrow("trusted_proxy_ips");
});

test("X-Forwarded-For is honoured only from a trusted peer, first element only", () => {
  const trusted = new Set(["127.0.0.1"]);
  expect(clientIp(req("127.0.0.1", "203.0.113.9, 10.0.0.1"), trusted)).toBe("203.0.113.9");
  expect(clientIp(req("198.51.100.7", "203.0.113.9"), trusted)).toBe("198.51.100.7");
  expect(clientIp(req("127.0.0.1"), trusted)).toBe("127.0.0.1");
  expect(clientIp(req("127.0.0.1", "203.0.113.9"), new Set())).toBe("127.0.0.1");
  expect(clientIp({ headers: { "x-forwarded-for": "203.0.113.9" } }, trusted)).toBe("unknown");
});
