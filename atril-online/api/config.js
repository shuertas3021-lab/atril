import { accountsOn, supabasePublic, getUser, passwordOk, providers, limits, month, sb, getStoredKeys, publicKeys } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (accountsOn()) {
    const user = await getUser(req);
    let usage = null, keys = { aiKeys: {}, aiPref: null };
    if (user) {
      keys = publicKeys(await getStoredKeys(user.id));
      try {
        const r = await sb(`/rest/v1/usage?user_id=eq.${user.id}&month=eq.${month()}&select=tts_chars,ai_calls`);
        if (r.ok) usage = (await r.json())[0] || { tts_chars: 0, ai_calls: 0 };
      } catch {}
    }
    return res.status(200).json({
      mode: 'accounts',
      supabase: supabasePublic(),
      authorized: !!user,
      me: user ? { email: user.email, name: user.name, isOwner: user.isOwner, usage, limits: user.isOwner ? null : limits(), ...keys } : null,
      voices: user ? providers() : {},
      ai: !!user && !!process.env.ANTHROPIC_API_KEY,
      inviteRequired: true,
    });
  }
  const authorized = passwordOk(req);
  res.status(200).json({
    mode: 'password',
    passwordRequired: !!process.env.APP_PASSWORD,
    authorized,
    voices: authorized ? providers() : {},
    ai: authorized && !!process.env.ANTHROPIC_API_KEY,
  });
}
