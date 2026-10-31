import {
  signRequest,
  verifySignedRequest,
} from "../../supabase/functions/_shared/signed_request.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const signingKey = "test-signing-key";
  const path = "/functions/v1/notify-defect";
  const nowSeconds = Math.floor(Date.now() / 1000);

  // 1) Valid
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:ok",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });

    const req = new Request(`https://example.invalid${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: bodyText,
    });

    const res = await verifySignedRequest(req, {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
    });

    assert(res.ok, "expected ok=true");
    assert(res.verified.requestId === "test:ok", "wrong requestId");
  }

  // 2) Modified body -> signature mismatch / 401
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:tamper",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });

    const req = new Request(`https://example.invalid${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ hello: "tampered" }),
    });

    const res = await verifySignedRequest(req, {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
    });

    assert(!res.ok, "expected ok=false");
    assert(res.denied.status === 401, "expected 401");
  }

  // 3) Expired timestamp -> 401
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:expired",
      timestampSeconds: nowSeconds - 3600,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });

    const req = new Request(`https://example.invalid${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: bodyText,
    });

    const res = await verifySignedRequest(req, {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
      maxAgeSeconds: 300,
    });

    assert(!res.ok, "expected ok=false");
    assert(res.denied.status === 401, "expected 401");
  }

  // 4) Future timestamp -> 401
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:future",
      timestampSeconds: nowSeconds + 600,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });

    const req = new Request(`https://example.invalid${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: bodyText,
    });

    const res = await verifySignedRequest(req, {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
      maxFutureSkewSeconds: 30,
    });

    assert(!res.ok, "expected ok=false");
    assert(res.denied.status === 401, "expected 401");
  }

  // 5) Wrong method and path -> 401
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const methodHeaders = await signRequest({
      signingKey,
      requestId: "test:method",
      timestampSeconds: nowSeconds,
      method: "GET",
      pathAndQuery: path,
      bodyText,
    });
    const methodRes = await verifySignedRequest(
      new Request(`https://example.invalid${path}`, {
        method: "GET",
        headers: methodHeaders.headers,
      }),
      { signingKey, expectedPathAndQuery: path, nowSeconds },
    );
    assert(!methodRes.ok && methodRes.denied.status === 401, "wrong method should return 401");

    const pathHeaders = await signRequest({
      signingKey,
      requestId: "test:path",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });
    const pathRes = await verifySignedRequest(
      new Request(`https://example.invalid${path}?unexpected=1`, {
        method: "POST",
        headers: pathHeaders.headers,
        body: bodyText,
      }),
      { signingKey, expectedPathAndQuery: path, nowSeconds },
    );
    assert(!pathRes.ok && pathRes.denied.status === 401, "wrong path should return 401");
  }

  // 6) Missing and malformed headers -> 401
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:headers",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });
    const noRequestId = { ...headers };
    delete noRequestId["x-request-id"];
    const malformedSignature = { ...headers, "x-signature": "v1=invalid" };
    const missingTimestamp = { ...headers };
    delete missingTimestamp["x-timestamp"];
    const invalidTimestamp = { ...headers, "x-timestamp": "not-a-timestamp" };

    for (const testHeaders of [
      noRequestId,
      malformedSignature,
      missingTimestamp,
      invalidTimestamp,
    ]) {
      const result = await verifySignedRequest(
        new Request(`https://example.invalid${path}`, {
          method: "POST",
          headers: testHeaders,
          body: bodyText,
        }),
        { signingKey, expectedPathAndQuery: path, nowSeconds },
      );
      assert(!result.ok && result.denied.status === 401, "invalid signing header should return 401");
    }
  }

  // 7) Replay (stateless) still verifies: this is expected and is why DB dedupe is required.
  {
    const bodyText = JSON.stringify({ hello: "world" });
    const { headers } = await signRequest({
      signingKey,
      requestId: "test:replay",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: path,
      bodyText,
    });

    const buildReq = () =>
      new Request(`https://example.invalid${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: bodyText,
      });

    const a = await verifySignedRequest(buildReq(), {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
    });
    const b = await verifySignedRequest(buildReq(), {
      signingKey,
      expectedPathAndQuery: path,
      nowSeconds,
    });

    assert(a.ok && b.ok, "expected both verifications to succeed without state");
  }

  // 8) Runtime URL is checked separately from the canonical public path.
  {
    const bodyText = JSON.stringify({ dryRun: true, allowDeactivation: false });
    const runtimePath = "/notify-expiring-invites";
    const signedPath = "/functions/v1/notify-expiring-invites";
    const signed = await signRequest({
      signingKey,
      requestId: "test:confirmed-runtime-path",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: signedPath,
      bodyText,
    });
    const expected = {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: runtimePath,
      nowSeconds,
    };

    const runtimeRequest = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: "POST",
        headers: signed.headers,
        body: bodyText,
      }),
      expected,
    );
    assert(
      runtimeRequest.ok,
      "confirmed runtime path should verify against the fixed public canonical path",
    );

    for (const invalidPath of [
      "/",
      signedPath,
      "/other",
      "/notify-expiring-invites/",
      "/notify-expiring-invites?extra=1",
    ]) {
      const invalidRequest = await verifySignedRequest(
        new Request(`https://example.invalid${invalidPath}`, {
          method: "POST",
          headers: signed.headers,
          body: bodyText,
        }),
        expected,
      );
      assert(
        !invalidRequest.ok &&
          invalidRequest.denied.status === 401,
        "invalid runtime path or query should remain unauthorized",
      );
    }

    const wrongMethod = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: "GET",
        headers: signed.headers,
      }),
      expected,
    );
    assert(
      !wrongMethod.ok &&
        wrongMethod.denied.status === 401,
      "notify-expiring-invites must reject non-POST methods",
    );
  }

  // 9) notify-defect runtime URL stays distinct from the public canonical path.
  {
    const bodyText = JSON.stringify({
      dryRun: true,
      id: "00000000-0000-0000-0000-000000000000",
    });
    const runtimePath = "/notify-defect";
    const signedPath = "/functions/v1/notify-defect";
    const signed = await signRequest({
      signingKey,
      requestId: "test:defect-runtime-path",
      timestampSeconds: nowSeconds,
      method: "POST",
      pathAndQuery: signedPath,
      bodyText,
    });
    const expected = {
      signingKey,
      expectedPathAndQuery: signedPath,
      expectedRuntimePathAndQuery: runtimePath,
      nowSeconds,
    };

    const runtimeRequest = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: "POST",
        headers: signed.headers,
        body: bodyText,
      }),
      expected,
    );
    assert(
      runtimeRequest.ok,
      "notify-defect runtime path should verify with the public canonical path",
    );

    for (const invalidPath of [
      "/",
      signedPath,
      "/other",
      "/notify-defect/",
      "/notify-defect?extra=1",
    ]) {
      const invalidRequest = await verifySignedRequest(
        new Request(`https://example.invalid${invalidPath}`, {
          method: "POST",
          headers: signed.headers,
          body: bodyText,
        }),
        expected,
      );
      assert(
        !invalidRequest.ok &&
          invalidRequest.denied.status === 401,
        "invalid notify-defect runtime path or query should remain unauthorized",
      );
    }

    const wrongMethod = await verifySignedRequest(
      new Request(`https://example.invalid${runtimePath}`, {
        method: "GET",
        headers: signed.headers,
      }),
      expected,
    );
    assert(
      !wrongMethod.ok &&
        wrongMethod.denied.status === 401,
      "notify-defect must reject non-POST methods",
    );
  }

  console.log("offline signed-request tests: PASS");
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
