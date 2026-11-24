// Stand-in for the Workers AI binding in local end-to-end tests (`npm run configure -- --local --mock-ai` sets
// AI_MOCK=1 and drops the AI binding, so `wrangler dev` never needs a Cloudflare login). Answers are canned and
// clearly labelled; nothing leaves the machine.
const TEXT = '**(AI mock: local test mode, no real model was called.)**\n\n1. **First things to check, cheapest first**: look, listen, check the obvious ($0).\n2. **OK to drive?** Probably, if nothing is leaking or warning.\n3. **Tell me next**: when does it happen?';
export const mockAi = {
  async run(model, body = {}) {
    if (body.stream) {
      const enc = new TextEncoder();
      return new ReadableStream({ start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: TEXT } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
        c.close();
      } });
    }
    return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };
  },
  async toMarkdown(files) { return (Array.isArray(files) ? files : [files]).map(f => ({ name: f.name, mimeType: 'text/markdown', format: 'markdown', data: '(AI mock: no conversion in local test mode)' })); },
};
