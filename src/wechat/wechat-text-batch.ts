/** Run inside the caller's text queue so a batch cannot be interleaved. */
export async function sendWechatTextBatch(
  texts: readonly string[],
  sendNow: (text: string) => Promise<boolean>,
): Promise<number> {
  let sentCount = 0;
  for (const text of texts) {
    if (!await sendNow(text)) break;
    sentCount += 1;
  }
  return sentCount;
}
