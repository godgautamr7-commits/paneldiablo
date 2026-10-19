'use strict';
/**
 * CLI helper used by install.sh to register (or update) an admin account.
 * Credentials come from environment variables so passwords never appear
 * in the process list:
 *   ADMIN_FIRST_NAME  ADMIN_LAST_NAME  ADMIN_USERNAME  ADMIN_EMAIL  ADMIN_PASSWORD
 * IMPORTANT: stop the panel first - it keeps the database in memory.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

const firstName = (process.env.ADMIN_FIRST_NAME || '').trim();
const lastName = (process.env.ADMIN_LAST_NAME || '').trim();
const username = (process.env.ADMIN_USERNAME || '').trim();
const email = (process.env.ADMIN_EMAIL || '').trim();
const password = process.env.ADMIN_PASSWORD || '';

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

if (!firstName || !lastName || !username || !email || !password) fail('first name, last name, username, email and password are required');
if (firstName.length > 50 || lastName.length > 50) fail('names must be 50 characters or fewer');
if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) fail('username must be 3-32 chars (letters, numbers, _ . -)');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('invalid email address');
if (password.length < 8) fail('password must be at least 8 characters');

const s = db.load();
let user = s.users.find(u => u.email.toLowerCase() === email.toLowerCase());
const clash = s.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u !== user);
if (clash) fail('username "' + username + '" is already used by another account');

if (user) {
  user.username = username;
  user.firstName = firstName;
  user.lastName = lastName;
  user.passwordHash = bcrypt.hashSync(password, 10);
  user.role = 'admin';
  db.save();
  console.log('UPDATED existing account as admin: ' + email);
} else {
  s.users.push({
    id: db.id('usr'), username, firstName, lastName, email,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'admin', coins: 100000, provider: 'local', avatar: null,
    createdAt: new Date().toISOString(), lastAfkAt: null
  });
  db.save();
  console.log('CREATED admin account: ' + email);
}
