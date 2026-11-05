// No CLI credentials or provider calls here except explicit models.login().
export async function loginWithPi({ models, store, interaction, signal }) {
  const credential = await models.login(
    "openai",
    "oauth",
    { ...interaction, signal },
    {
      getDeviceId: () => store.deviceId(),
      agentName: "Yorishiro",
    },
  );
  // Never return secret bodies to the IPC caller or log the credential object.
  return { provider: "openai", type: credential.type, connected: true };
}
