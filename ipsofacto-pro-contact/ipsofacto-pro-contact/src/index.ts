
/// <reference lib="dom" />
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.startsWith("/contact")) {
      const form = await request.formData();

      const name = form.get("name");
      const telephone = form.get("telephone");

      const email = form.get("email");

      const formData = await request.formData();
      const message = formData.get("message")?.toString() ?? "(empty message)";

      const body = `
New contact form submission:

Name: ${name}
Telephone: ${telephone}
Email: ${email}

Message:
${message}
      `;

      await fetch("https://api.mailchannels.net/tx/v1/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            personalizations: [
              { to: [{ email: "contact@ipsofacto.pro" }] }
            ],
            from: { email: "contact@ipsofacto.pro", name: "Ipsofacto Contact Form" },
            subject: "New Contact Form Submission",
            content: [{ type: "text/plain", value: body }]
          })
        });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};
