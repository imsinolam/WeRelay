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
  const deps = { now: () => now, cooldownMs: 1, persist: (next: ReturnType<ContextSendGuard["snapshot"]>) => { state = next; } };
  const args = { recipient: "a", getToken: () => "secret-token", isExplicitRejection, send: async () => { calls++; throw denied; } };
  for (let i = 0; i < 3; i++) {
    await expect(new ContextSendGuard({ ...deps, initial: state }).send(args)).rejects.toBe(denied);
    now += 100;
  }
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(args)).rejects.toThrow("暂停");
  expect(calls).toBe(3);
  expect(JSON.stringify(state)).not.toContain("secret-token");
  const uncertainArgs = { ...args, recipient: "b", send: async () => { calls++; throw new Error("timeout"); } };
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(uncertainArgs)).rejects.toThrow("未确认");
  await expect(new ContextSendGuard({ ...deps, initial: state }).send(uncertainArgs)).rejects.toThrow("未确认");
  expect(calls).toBe(4);
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
    expect((outcome as Error).message).toContain(newerRejections === 1 ? "退避" : "暂停");
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
