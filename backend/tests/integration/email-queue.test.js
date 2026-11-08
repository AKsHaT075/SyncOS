jest.mock('../../src/services/email.service', () => ({
  sendEmail: jest.fn(),
}));

const crypto = require('crypto');
const emailService = require('../../src/services/email.service');
const queue = require('../../src/services/email-queue');
const { connectRedis, createRedisClient } = require('../../src/config/redis');

const { KEYS } = queue;
let client;
const sendEmail = emailService.sendEmail;

const job = (overrides = {}) => ({ to: 'a@x.test', subject: 'Hi', text: 'hi', html: '<p>hi</p>', ...overrides });

async function flush() {
  const keys = await client.keys('test:email:*');
  if (keys.length) await client.del(keys);
}

const statuses = [];
queue.onJobResult((event) => statuses.push(event));

beforeAll(async () => {
  client = await connectRedis();
});

beforeEach(async () => {
  await flush();
  sendEmail.mockReset().mockResolvedValue({ ok: true });
  statuses.length = 0;
});

afterAll(async () => {
  await flush();
  await client.quit();
});

describe('basic delivery', () => {
  it('delivers a queued email and leaves nothing behind', async () => {
    expect(await queue.enqueueEmail(job())).toBe(true);
    expect(await queue.processOnce()).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith({ to: 'a@x.test', subject: 'Hi', text: 'hi', html: '<p>hi</p>' });
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 0 });
    expect(await queue.processOnce()).toBe(false); // idle
  });

  it('still processes jobs in the legacy format queued by the previous version', async () => {
    await client.rPush(KEYS.ready, JSON.stringify({ to: 'old@x.test', subject: 'Old', text: 't', html: '<p>t</p>', attempts: 0 }));
    expect(await queue.processOnce()).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'old@x.test', subject: 'Old' }));
  });

  it('keeps the public email.service API and wording for existing flows', async () => {
    const actual = jest.requireActual('../../src/services/email.service');
    await actual.sendMeetingInvitationEmail({
      to: 'm@x.test', meetingTopic: 'Sprint', projectName: 'Apollo', startTime: new Date('2030-01-01T10:00:00Z'), joinUrl: 'http://x/y',
    });
    await actual.sendMeetingRequestDecisionEmail({ to: 'r@x.test', topic: 'Sync', status: 'Approved', remarks: 'ok' });
    await actual.sendOtpEmail({ to: 'o@x.test', otp: '123456', firstName: 'Ola' });

    const raw = (await client.lRange(KEYS.ready, 0, -1)).map((entry) => JSON.parse(entry));
    expect(raw).toHaveLength(3);
    expect(raw[0].subject).toBe('Meeting invite: Sprint');
    expect(raw[0].text).toBe('You\'ve been invited to "Sprint" on the Apollo project, scheduled for Tue, 01 Jan 2030 10:00:00 GMT. Join here: http://x/y');
    expect(raw[1].subject).toBe('Your meeting request "Sync" was approved');
    expect(raw[1].text).toBe('Your meeting request "Sync" has been approved. Remarks: ok');
    expect(raw[2].text).toContain('123456');
    raw.forEach((entry) => expect(entry.attempts).toBe(0));
  });

  it('enqueue never throws when Redis fails — it reports false', async () => {
    const spy = jest.spyOn(client, 'rPush').mockRejectedValueOnce(new Error('redis down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(queue.enqueueEmail(job())).resolves.toBe(false);
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('retries with delayed backoff', () => {
  it('a failing email does not block the ones behind it', async () => {
    sendEmail.mockRejectedValueOnce(new Error('smtp 451'));
    await queue.enqueueEmail(job({ to: 'bad@x.test' }));
    await queue.enqueueEmail(job({ to: 'good@x.test' }));

    const start = Date.now();
    await queue.processOnce({ now: start });
    await queue.processOnce({ now: start });

    expect(sendEmail).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: 'good@x.test' }));
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 1, dead: 0 });
    expect(statuses.map((s) => s.status)).toEqual(['retrying', 'sent']);
  });

  it('retries after the backoff and then succeeds', async () => {
    sendEmail.mockRejectedValueOnce(new Error('timeout'));
    await queue.enqueueEmail(job());
    const t0 = Date.now();

    await queue.processOnce({ now: t0 });
    expect(await queue.processOnce({ now: t0 + 1000 })).toBe(false); // still backing off (5s)
    expect(await queue.processOnce({ now: t0 + 6000 })).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(statuses.map((s) => s.status)).toEqual(['retrying', 'sent']);
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 0 });
  });

  it('dead-letters a job after the retries are exhausted, keeping the error', async () => {
    sendEmail.mockRejectedValue(new Error('mailbox does not exist'));
    await queue.enqueueEmail(job({ to: 'gone@x.test', meta: { notificationId: 'n1' } }));
    let now = Date.now();

    // attempt 1 + MAX_RETRIES retries
    for (let attempt = 0; attempt <= queue.MAX_RETRIES; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await queue.processOnce({ now })).toBe(true);
      now += 3 * 60 * 1000; // jump past any backoff
    }

    expect(sendEmail).toHaveBeenCalledTimes(queue.MAX_RETRIES + 1);
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 1 });

    const [dead] = (await client.lRange(KEYS.dead, 0, -1)).map((entry) => JSON.parse(entry));
    expect(dead).toMatchObject({ to: 'gone@x.test', error: 'mailbox does not exist', attempts: queue.MAX_RETRIES + 1 });
    expect(dead.failedAt).toBeTruthy();
    expect(statuses.map((s) => s.status)).toEqual(['retrying', 'retrying', 'retrying', 'failed']);
    expect(statuses[3].job.meta.notificationId).toBe('n1');
  });

  it('dead-letters an unparseable job instead of crashing the worker', async () => {
    await client.rPush(KEYS.ready, 'not json {');
    expect(await queue.processOnce()).toBe(true);
    const [dead] = (await client.lRange(KEYS.dead, 0, -1)).map((entry) => JSON.parse(entry));
    expect(dead.error).toMatch(/unparseable/);
    expect(await queue.getQueueStats()).toMatchObject({ ready: 0, processing: 0, dead: 1 });
  });
});

describe('worker crashes and restarts', () => {
  async function simulateCrashedClaim(extra = {}, claimedAt = Date.now() - 10 * 60 * 1000) {
    const raw = JSON.stringify({ queueId: crypto.randomUUID(), ...job(), attempts: 0, ...extra });
    await client.zAdd(KEYS.processing, { score: claimedAt, value: raw }); // claimed, then the worker died
    return raw;
  }

  it('recovers a job that a dead worker had claimed, and delivers it exactly once', async () => {
    await simulateCrashedClaim({ to: 'orphan@x.test' });
    expect((await queue.getQueueStats()).processing).toBe(1);

    expect(await queue.recoverStale(client, Date.now())).toBe(1);
    await queue.processOnce();
    await queue.processOnce(); // nothing left to send

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'orphan@x.test' }));
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 0 });
  });

  it('does not steal a claim that is still fresh (a live worker mid-send)', async () => {
    await simulateCrashedClaim({}, Date.now() - 10 * 1000);
    expect(await queue.recoverStale(client, Date.now())).toBe(0);
    expect(await queue.getQueueStats()).toMatchObject({ ready: 0, processing: 1 });
  });

  it('dead-letters a poison job that keeps crashing workers instead of looping forever', async () => {
    await simulateCrashedClaim({ attempts: queue.MAX_RETRIES, meta: { notificationId: 'n9' } });
    expect(await queue.recoverStale(client, Date.now())).toBe(0);
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 1 });
    expect(statuses[0]).toMatchObject({ status: 'failed' });
  });

  it('a restarted worker loop recovers stale jobs immediately and processes new ones', async () => {
    await simulateCrashedClaim({ to: 'before-restart@x.test' });
    const worker = queue.processEmailQueue({ pollMs: 20 });

    await queue.enqueueEmail(job({ to: 'after-restart@x.test' }));
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (sendEmail.mock.calls.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    queue.stopEmailWorker();
    await worker;

    const recipients = sendEmail.mock.calls.map(([mail]) => mail.to).sort();
    expect(recipients).toEqual(['after-restart@x.test', 'before-restart@x.test']);
  });

  it('keeps the job when bookkeeping fails after a failed send (never loses it)', async () => {
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    await queue.enqueueEmail(job());
    const zAdd = jest.spyOn(client, 'zAdd').mockRejectedValueOnce(new Error('redis blip'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await queue.processOnce();
    zAdd.mockRestore();
    errorSpy.mockRestore();

    // Still claimed (not acked, not lost): recovery will pick it up.
    expect((await queue.getQueueStats()).processing).toBe(1);
    expect(await queue.recoverStale(client, Date.now() + 10 * 60 * 1000)).toBe(1);
  });
});

describe('duplicate delivery protection', () => {
  it('sends a jobId only once even if it was queued twice', async () => {
    await queue.enqueueEmail(job({ jobId: 'notif:1' }));
    await client.rPush(KEYS.ready, JSON.stringify({ queueId: 'dup', ...job(), attempts: 0, jobId: 'notif:1' }));

    await queue.processOnce();
    await queue.processOnce();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 0 });
  });

  it('does not even queue a jobId that was already delivered', async () => {
    await queue.enqueueEmail(job({ jobId: 'notif:2' }));
    await queue.processOnce();
    expect(await queue.enqueueEmail(job({ jobId: 'notif:2' }))).toBe(true);
    expect((await queue.getQueueStats()).ready).toBe(0);
  });

  it('skips a job another worker is sending right now (send lock)', async () => {
    await client.set(KEYS.lock('notif:3'), '1', { EX: 60 });
    await queue.enqueueEmail(job({ jobId: 'notif:3' }));
    await queue.processOnce();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await queue.getQueueStats()).toEqual({ ready: 0, processing: 0, delayed: 0, dead: 0 });
  });

  it('a failed send releases the lock so the retry can proceed', async () => {
    sendEmail.mockRejectedValueOnce(new Error('boom'));
    await queue.enqueueEmail(job({ jobId: 'notif:4' }));
    const t0 = Date.now();
    await queue.processOnce({ now: t0 });
    expect(await client.exists(KEYS.lock('notif:4'))).toBe(0);
    await queue.processOnce({ now: t0 + 6000 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(await client.exists(KEYS.done('notif:4'))).toBe(1);
  });

  it('jobs without a jobId (OTP, reset, invitations) behave as before: no dedupe, all delivered', async () => {
    await queue.enqueueEmail(job());
    await queue.enqueueEmail(job());
    await queue.processOnce();
    await queue.processOnce();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});
