const express = require('express');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

const config = require('../config.json');
const { db } = require('../handlers/db');
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail
} = require('../handlers/email');

const router = express.Router();
const saltRounds = 10;

/* ================= PASSPORT ================= */

passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const users = await db.get('users') || [];
    const settings = await db.get('settings') || {};

    const user = username.includes('@')
      ? users.find(u => u.email === username)
      : users.find(u => u.username === username);

    if (!user) return done(null, false, { message: 'Invalid credentials' });

    if (settings.emailVerification && !user.verified) {
      return done(null, false, { userNotVerified: true });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return done(null, false);

    return done(null, user);
  } catch (err) {
    done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.userId));

passport.deserializeUser(async (id, done) => {
  try {
    const users = await db.get('users') || [];
    const user = users.find(u => u.userId === id);
    done(null, user || false);
  } catch (e) {
    done(e);
  }
});

/* ================= LOGIN ================= */

router.get('/login', async (req, res) => {
  res.render('auth/login', {
    req,
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

router.post('/auth/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      if (info?.userNotVerified) return res.redirect('/login?err=VerifyEmail');
      return res.redirect('/login?err=Invalid');
    }

    req.login(user, err => {
      if (err) return next(err);

      if (user.twoFAEnabled && user.twoFASecret) {
        req.session.temp2FA = user.userId;
        req.logout(() => res.redirect('/2fa'));
      } else {
        res.redirect('/dashboard');
      }
    });
  })(req, res, next);
});

/* ================= 2FA ================= */

router.get('/2fa', async (req, res) => {
  if (!req.session.temp2FA) return res.redirect('/login');
  res.render('auth/2fa', { req });
});

router.post('/2fa', async (req, res) => {
  const users = await db.get('users') || [];
  const user = users.find(u => u.userId === req.session.temp2FA);
  if (!user || !user.twoFASecret) return res.redirect('/login');

  const verified = speakeasy.totp.verify({
    secret: user.twoFASecret,
    encoding: 'base32',
    token: req.body.token
  });

  if (!verified) return res.redirect('/2fa?err=Invalid');

  req.session.temp2FA = null;
  req.login(user, () => res.redirect('/dashboard'));
});

/* ================= REGISTER ================= */

router.get('/register', async (req, res) => {
  const settings = await db.get('settings') || {};
  if (!settings.register) return res.redirect('/login');

  res.render('auth/register', { req });
});

router.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  const users = await db.get('users') || [];

  if (users.some(u => u.username === username || u.email === email)) {
    return res.redirect('/register?err=Exists');
  }

  const hashed = await bcrypt.hash(password, saltRounds);
  const token = generateRandomCode(32);

  users.push({
    userId: uuidv4(),
    username,
    email,
    password: hashed,
    verified: false,
    verificationToken: token,
    admin: false
  });

  await db.set('users', users);
  await sendVerificationEmail(email, token);

  res.redirect('/login?msg=VerifyEmail');
});

/* ================= VERIFY ================= */

router.get('/verify/:token', async (req, res) => {
  const users = await db.get('users') || [];
  const user = users.find(u => u.verificationToken === req.params.token);
  if (!user) return res.redirect('/login?err=InvalidToken');

  user.verified = true;
  user.verificationToken = null;
  await db.set('users', users);

  res.redirect('/login?msg=Verified');
});

/* ================= RESET PASSWORD ================= */

router.post('/auth/reset-password', async (req, res) => {
  const users = await db.get('users') || [];
  const user = users.find(u => u.email === req.body.email);
  if (!user) return res.redirect('/auth/reset-password?err=NotFound');

  user.resetToken = generateRandomCode(32);
  user.resetExpire = Date.now() + 15 * 60 * 1000;
  await db.set('users', users);

  await sendPasswordResetEmail(user.email, user.resetToken);
  res.redirect('/login?msg=EmailSent');
});

router.post('/auth/reset/:token', async (req, res) => {
  const users = await db.get('users') || [];
  const user = users.find(u => u.resetToken === req.params.token);

  if (!user || Date.now() > user.resetExpire) {
    return res.redirect('/login?err=Expired');
  }

  user.password = await bcrypt.hash(req.body.password, saltRounds);
  delete user.resetToken;
  delete user.resetExpire;

  await db.set('users', users);
  res.redirect('/login?msg=PasswordReset');
});

/* ================= LOGOUT ================= */

router.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

function generateRandomCode(len) {
  return [...Array(len)]
    .map(() => Math.random().toString(36)[2])
    .join('');
}

module.exports = router;
