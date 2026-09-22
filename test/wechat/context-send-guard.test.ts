import { expect, test } from "bun:test";
import { ContextSendGuard } from "../../src/wechat/context-send-guard.ts";

const denied = new Error("upstream prepare rejected");
const isExplicitRejection = (error: unknown) => error === denied;

test("old failed request retries the refreshed token without invalidating it", async () => {
  let token = "old";
  const calls: string[] = [];
  await new ContextSendGuard().send({ recipient: "recipient", getToken: () => token, isExplicitRejection,
    send: async (sent) => { calls.push(sent); if (sent === "old") { token = "new"; throw denied; } },
  });
  expect(calls).toEqual(["old", "new"]);
  expect(token).toBe("new");
});

test("rejection retains the token and can recover without new inbound after cooldown", async () => {
  let now = 0; let calls = 0;
  const guard = new ContextSendGuard({ now: () => now, cooldownMs: 100 });
  const args = { recipient: "recipient", getToken: () => "same", isExplicitRejection,
    send: async () => { if (++calls === 1) throw denied; } };
  await expect(guard.send(args)).rejects.toBe(denied);
  await expect(guard.send(args)).rejects.toThrow("退避");
  expect(calls).toBe(1);
  now = 101;
  await guard.send(args);
  expect(calls).toBe(2);
});

test("new token bypasses rejection cooldown, including a different message type", async () => {
  const guard = new ContextSendGuard(); let token = "old";
  const base = { recipient: "recipient", getToken: () => token, isExplicitRejection };
  await expect(guard.send({ ...base, send: async () => { throw denied; } })).rejects.toBe(denied);
  token = "new";
  const calls: string[] = [];
  await guard.send({ ...base, send: async (sent) => { calls.push(sent); } });
  expect(calls).toEqual(["new"]);
});

test("a refreshed inbound context releases unconfirmed sends for that recipient", async () => {
  const guard = new ContextSendGuard();
  const recipient = "account-token\0recipient";
  const args = {
    recipient,
    requestKey: "old-response",
    getToken: () => "new-context-token",
    isExplicitRejection,
    send: async () => { throw new Error("network timeout"); },
  };

  await expect(guard.send(args)).rejects.toThrow("未确认");
  guard.markContextRefreshed(recipient);

  const calls: string[] = [];
  await guard.send({
    ...args,
    requestKey: "new-response",
    send: async (token) => { calls.push(token); },
  });
  expect(calls).toEqual(["new-context-token"]);
});

test("uncertain network failures do not automatically resend", async () => {
  let calls = 0; const network = new Error("connection lost");
  await expect(new ContextSendGuard().send({ recipient: "recipient", getToken: () => "current", isExplicitRejection,
    send: async () => { calls++; throw network; },
  })).rejects.toThrow("结果未确认");
  expect(calls).toBe(1);
});

test("one recipient rejection does not block another recipient", async () => {
  const guard = new ContextSendGuard();
  await expect(guard.send({ recipient: "a", getToken: () => "token", isExplicitRejection, send: async () => { throw denied; } })).rejects.toBe(denied);
  await guard.send({ recipient: "b", getToken: () => "token", isExplicitRejection, send: async () => {} });
});

 test("restart preserves rejection limits and never retries an uncertain message", async () => {
  let state: ReturnType<ContextSendGuard["snapshot"]> | undefined;
  let now = 0; let calls = 0;
  // cooldownMs 取足够大，使每次失败后的退避期可被精确跨过。
  const deps = { now: () => now, cooldownMs: 60_000, persist: (next: ReturnType<ContextSendGuard["snapshot"]>) => { state = next; } };
  const args = { recipient: "a", getToken: () => "secret-token", isExplicitRejection, send: async () => { calls++; throw denied; } };
  for (let i = 0; i < 3; i++) {
    await expect(new ContextSendGuard({ ...deps, initial: state }).send(args)).rejects.toBe(denied);
    if (i < 2) now += 30 * 60_000 + 1;
  }
  // 第三次失败后处于退避期：应被拦截，但只是退避而非永久暂停。
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(args)).rejects.toThrow("退避");
  expect(calls).toBe(3);
  // 退避期过后必须允许再试，否则 rejected 永远清不掉，发送链永久死锁。
  now += 30 * 60_000 + 1;
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(args)).rejects.toBe(denied);
  expect(calls).toBe(4);
  expect(JSON.stringify(state)).not.toContain("secret-token");
  const uncertainArgs = { ...args, recipient: "b", send: async () => { calls++; throw new Error("timeout"); } };
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(uncertainArgs)).rejects.toThrow("未确认");
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(uncertainArgs)).rejects.toThrow("未确认");
  expect(calls).toBe(5);
 });

test("write-ahead state makes a process crash during send require confirmation", async () => {
  let saved: ReturnType<ContextSendGuard["snapshot"]> | undefined;
  const guard = new ContextSendGuard({ persist: (state) => { saved = state; } });
  await guard.send({ recipient: "a", getToken: () => "t", isExplicitRejection,
    send: async () => {
      const restarted = new ContextSendGuard({ initial: saved });
      await expect(restarted.send({ recipient: "a", getToken: () => "t", isExplicitRejection,
        send: async () => { throw new Error("must not replay after crash"); },
      })).rejects.toThrow("未确认");
    },
  });
  expect(saved?.uncertain).toEqual([]);
});

for (const newerRejections of [1, 3]) {
  test(`late old rejection respects new token ${newerRejections === 1 ? "cooldown" : "circuit"}`, async () => {
    let now = 0;
    let token = "old";
    let calls = 0;
    let releaseOld!: () => void;
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
    const guard = new ContextSendGuard({ now: () => now, cooldownMs: 1 });
    const base = { recipient: "same-account-recipient", getToken: () => token, isExplicitRejection };
    const oldOutcome = guard.send({ ...base, requestKey: "old-message", send: async () => {
      calls++;
      await oldPending;
      throw denied;
    } }).then(() => null, (error: unknown) => error);
    token = "new";
    for (let index = 0; index < newerRejections; index++) {
      if (index > 0) now += 100;
      await expect(guard.send({ ...base, requestKey: `new-message-${index}`, send: async () => {
        calls++;
        throw denied;
      } })).rejects.toBe(denied);
    }
    const protectedState = guard.snapshot().rejected;
    releaseOld();
    const outcome = await oldOutcome;
    expect(outcome).toBeInstanceOf(Error);
    // 无论累计拒绝次数多少，都只按退避期拦截，不再出现永久暂停。
    expect((outcome as Error).message).toContain("退避");
    expect(calls).toBe(1 + newerRejections);
    expect(guard.snapshot().rejected).toEqual(protectedState);
    expect(guard.snapshot().uncertain).toEqual([]);
  });
}

test("every rejection disk checkpoint preserves either in-flight uncertainty or final rejection count", async () => {
  let now = 0;
  const writes: ReturnType<ContextSendGuard["snapshot"]>[] = [];
  const guard = new ContextSendGuard({ now: () => now, cooldownMs: 1, persist: (state) => { writes.push(state); } });
  for (let rejectionCount = 1; rejectionCount <= 3; rejectionCount++) {
    now += 100;
    const writeStart = writes.length;
    await expect(guard.send({ recipient: "recipient", getToken: () => "same-token", isExplicitRejection,
      send: async () => { throw denied; },
    })).rejects.toBe(denied);
    for (const checkpoint of writes.slice(writeStart)) {
      expect(checkpoint.uncertain.length > 0 || checkpoint.rejected[0]?.[1].attempts === rejectionCount).toBe(true);
      let restartedCalls = 0;
      const restarted = new ContextSendGuard({ initial: checkpoint, now: () => now, cooldownMs: 1 });
      await expect(restarted.send({ recipient: "recipient", getToken: () => "same-token", isExplicitRejection,
        send: async () => { restartedCalls++; },
      })).rejects.toThrow();
      expect(restartedCalls).toBe(0);
    }
  }
});

test("multiple old requests returning late cannot consume new token attempts", async () => {
  let token = "old";
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const guard = new ContextSendGuard({ now: () => 0 });
  const base = { recipient: "r", getToken: () => token, isExplicitRejection };
  const oldOutcomes = Array.from({ length: 3 }, (_, index) => guard.send({ ...base,
    requestKey: `old-${index}`, send: async () => { calls++; await pending; throw denied; },
  }).then(() => null, (error: unknown) => error));
  token = "new";
  await expect(guard.send({ ...base, requestKey: "new", send: async () => { calls++; throw denied; } })).rejects.toBe(denied);
  const protectedState = guard.snapshot().rejected;
  release();
  for (const outcome of await Promise.all(oldOutcomes)) {
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("退避");
  }
  expect(calls).toBe(4);
  expect(guard.snapshot().rejected).toEqual(protectedState);
  expect(guard.snapshot().uncertain).toEqual([]);
});

test("failed atomic rejection write leaves restart protected by the previous in-flight marker", async () => {
  let disk: ReturnType<ContextSendGuard["snapshot"]> | undefined;
  let writes = 0;
  const guard = new ContextSendGuard({ persist: (state) => {
    if (++writes === 2) throw new Error("atomic write interrupted");
    disk = state;
  } });
  const base = { recipient: "r", getToken: () => "t", isExplicitRejection };
  await expect(guard.send({ ...base, send: async () => { throw denied; } })).rejects.toThrow("atomic write interrupted");
  expect(disk?.uncertain.length).toBe(1);
  let calls = 0;
  await expect(new ContextSendGuard({ initial: disk }).send({ ...base, send: async () => { calls++; } })).rejects.toThrow("未确认");
  expect(calls).toBe(0);
});

test("an unconfirmed send no longer blocks its request forever", async () => {
  // A send whose result can never be confirmed must eventually be retryable,
  // otherwise one bad send permanently stalls the serialized WeChat chain.
  let clock = 1_000_000;
  let sends = 0;
  const guard = new ContextSendGuard({
    now: () => clock,
    uncertainTtlMs: 60_000,
    send: undefined as never,
  } as never);
  const args = {
    recipient: "owner",
    getToken: () => "token-a",
    isExplicitRejection: () => false,
  };

  // First attempt: transport failure leaves the request unconfirmed.
  await expect(guard.send({ ...args, send: async () => { sends += 1; throw new Error("timeout"); } }))
    .rejects.toThrow("未确认");
  expect(guard.snapshot().uncertain.length).toBe(1);

  // Immediately after, the request is still blocked (no blind replay).
  await expect(guard.send({ ...args, send: async () => { sends += 1; } }))
    .rejects.toThrow("未确认");
  expect(sends).toBe(1);

  // Once the recovery window passes, the marker is retired and the request
  // can be attempted again instead of failing until manual intervention.
  clock += 61_000;
  await guard.send({ ...args, send: async () => { sends += 1; } });
  expect(sends).toBe(2);
  expect(guard.snapshot().uncertain).toEqual([]);
});

test("drops expired uncertainty loaded from disk instead of restoring a permanent block", () => {
  const clock = 5_000_000;
  const key = "a".repeat(64);
  const guard = new ContextSendGuard({
    now: () => clock,
    uncertainTtlMs: 60_000,
    initial: { rejected: [], uncertain: [{ key, at: clock - 120_000 }] },
  });
  // The stale marker must not survive a restart.
  expect(guard.snapshot().uncertain).toEqual([]);
});

test("keeps a fresh uncertainty marker across a restart", () => {
  const clock = 5_000_000;
  const key = "b".repeat(64);
  const guard = new ContextSendGuard({
    now: () => clock,
    uncertainTtlMs: 60_000,
    initial: { rejected: [], uncertain: [{ key, at: clock - 1_000 }] },
  });
  expect(guard.snapshot().uncertain).toEqual([{ key, at: clock - 1_000 }]);
});


test("a fresh context token releases persisted uncertainty after restart", async () => {
  let persisted: ReturnType<ContextSendGuard["snapshot"]> | undefined;
  const first = new ContextSendGuard({
    persist: (state) => { persisted = structuredClone(state); },
  });
  const args = {
    recipient: "account\0owner",
    requestKey: "sendImage:stable-digest",
    getToken: () => "token-a",
    isExplicitRejection: () => false,
  };

  await expect(first.send({
    ...args,
    send: async () => { throw new Error("timeout"); },
  })).rejects.toThrow("未确认");

  const restarted = new ContextSendGuard({ initial: persisted });
  restarted.markContextRefreshed("account\0owner");

  let sends = 0;
  await restarted.send({
    ...args,
    getToken: () => "token-b",
    send: async () => { sends += 1; },
  });
  expect(sends).toBe(1);
  expect(restarted.snapshot().uncertain).toEqual([]);
});

test("still accepts the legacy bare-fingerprint uncertainty format", () => {
  const clock = 5_000_000;
  const key = "c".repeat(64);
  const guard = new ContextSendGuard({
    now: () => clock,
    uncertainTtlMs: 60_000,
    // Older state files stored plain strings with no timestamp.
    initial: { rejected: [], uncertain: [key] },
  });
  const snapshot = guard.snapshot();
  expect(snapshot.uncertain.length).toBe(1);
  expect(snapshot.uncertain[0]).toMatchObject({ key });
});

test("a token rejected repeatedly still retries after its backoff expires", async () => {
  // 回归：attempts >= 3 曾让暂停永久生效，形成死锁——永不允许再尝试，
  // 于是永远无法成功，rejected 也永不清除，整条发送链再也不能恢复。
  let now = 0;
  let calls = 0;
  const guard = new ContextSendGuard({ now: () => now, cooldownMs: 100 });
  const args = {
    recipient: "recipient",
    getToken: () => "same",
    isExplicitRejection,
    send: async () => { calls += 1; throw denied; },
  };

  // 连续失败到 attempts 达到 3（此前会进入永久暂停）。
  await expect(guard.send(args)).rejects.toBe(denied);
  now += 101;
  await expect(guard.send(args)).rejects.toBe(denied);
  now += 100 * 5 + 1;
  await expect(guard.send(args)).rejects.toBe(denied);
  expect(calls).toBe(3);

  // 退避期结束后必须再次尝试，而不是永久阻塞。
  now += 30 * 60_000 + 1;
  await expect(guard.send(args)).rejects.toBe(denied);
  expect(calls).toBe(4);
});
