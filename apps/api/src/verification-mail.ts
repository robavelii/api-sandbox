export function verificationMailer(
  key = process.env.RESEND_API_KEY,
  from = process.env.VERIFICATION_FROM,
  transport: typeof fetch = fetch,
) {
  if (!key || !from) return undefined;
  return async (email: string, code: string) => {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Verify your SpecTwin email",
        text: `Your SpecTwin verification code is:\n\n${code}\n\nSign in and enter this code in account security. It expires in 24 hours. If you did not request this, ignore this email.`,
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Verification email provider failed.");
  };
}
