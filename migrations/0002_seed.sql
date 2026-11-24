-- Seed: the built-in "household" member. It is who you are in the password and no-auth modes (each session still
-- records the name you typed at sign-in). OIDC / Cloudflare Access members are added at setup or in Settings.
-- No cars here: add yours with the add-car skill (or Settings -> Add a car). Demo data: scripts/seed-demo.mjs.
INSERT INTO members (id, email, sub, name, is_owner, created_at) VALUES
  ('m-household', 'household@garage.invalid', NULL, 'Household', 1, strftime('%s','now'));
