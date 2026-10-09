// Loaded only by the existing WeRelay OpenCode server, never in a second session.
export const WeRelaySessionSettings = async ({ client }) => ({
  "chat.message": async (input, output) => {
    const result = await client.session.get({ sessionID: input.sessionID, path: { id: input.sessionID } });
    if (result.error) throw new Error("无法确认原任务模型设置，请刷新任务后重试。");
    const selection = result.data?.metadata?.werelayModelSelection;
    if (!selection?.providerID || !selection?.modelID) return;
    const model = { providerID: selection.providerID, modelID: selection.modelID };
    if (selection.variant) model.variant = selection.variant;
    output.message.model = model;
    // Older OpenCode stores the variant alongside the user message's model.
    if ("variant" in output.message) output.message.variant = selection.variant;
  },
});
