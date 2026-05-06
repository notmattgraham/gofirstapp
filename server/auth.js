// Passport + Google OAuth. Users are upserted on each login based on
// their stable Google ID so we don't duplicate accounts if email changes.
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const prisma = require('./db');

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user || false);
  } catch (e) {
    done(e);
  }
});

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${baseUrl}/api/auth/google/callback`,
    proxy: true,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] && profile.emails[0].value;
      const name = profile.displayName || null;
      const picture = profile.photos && profile.photos[0] && profile.photos[0].value;

      if (!email) return done(new Error('Google account has no email'));

      // First sign-in: seed everything from Google. Subsequent sign-ins:
      // only refresh email (in case the user changed their primary Google
      // address). Never overwrite name or picture — those are user-editable
      // in the profile and must survive future logins.
      const existing = await prisma.user.findUnique({ where: { googleId: profile.id } });
      const user = existing
        ? await prisma.user.update({
            where: { id: existing.id },
            data: { email },
          })
        : await prisma.user.create({
            data: { googleId: profile.id, email, name, picture },
          });
      done(null, user);
    } catch (e) {
      done(e);
    }
  }));
} else {
  console.warn('[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing — Google login disabled.');
}

module.exports = passport;
