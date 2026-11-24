# Third-party software

The kit's own code is MIT (see LICENSE). It includes or loads these, under their own licenses:

| Component | Where | License |
|---|---|---|
| three.js 0.160.0 (core, `three.module.min.js`) | vendored in `public/vendor/three-0.160.0/` | MIT, Copyright 2010-2023 three.js authors |
| three.js `GLTFLoader.js`, `BufferGeometryUtils.js` (examples/jsm, 0.160.0) | vendored in `public/vendor/three-0.160.0/` | MIT, three.js authors |
| meshoptimizer decoder (`meshopt_decoder.module.js`) | vendored in `public/vendor/three-0.160.0/` | MIT, Copyright 2016-2022 Arseny Kapoulkine |
| @cloudflare/workers-oauth-provider 1.2.4 | npm dependency (bundled into the Worker) | MIT, Cloudflare, Inc. |
| postal-mime | npm dependency (bundled into the Worker) | MIT-0, Andris Reinman |
| wrangler | npm dev dependency (not deployed; bundles the Worker for the Docker image) | MIT OR Apache-2.0, Cloudflare, Inc. |
| miniflare | Docker image (runs the Worker) | MIT, Cloudflare, Inc. |
| workerd | Docker image (the Workers runtime, via miniflare) | Apache-2.0, Cloudflare, Inc. |
| undici | Docker image (outbound HTTP) | MIT, Node.js contributors |
| imapflow | Docker image (IMAP email-in) | MIT, Postal Systems OÜ |
| unpdf (incl. PDF.js) | Docker image (PDF text) | MIT (unpdf), Apache-2.0 (PDF.js, Mozilla) |
| Node.js, Debian (base image `node:22-bookworm-slim`), tini | Docker image | MIT (Node.js); Debian packages under their own licenses; MIT (tini) |
| Inter, Rajdhani fonts | loaded from Google Fonts | SIL Open Font License 1.1 |
| NHTSA vPIC API | called at runtime (VIN decode) | US government public data |

No third-party 3D models are included: the cars are procedural (our own code). A .glb you upload stays in your own
Cloudflare account (or your own `/data` folder with Docker); only upload models you made or are allowed to use.
