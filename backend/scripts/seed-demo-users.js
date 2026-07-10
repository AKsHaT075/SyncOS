require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const env = require('../src/config/env');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const { ROLES } = require('../src/constants/roles');

const PASSWORD_SALT_ROUNDS = 12;
const DEMO_PASSWORD = 'Demo@1234';
const ORG_NAME = 'Myra Inc.';

const DEMO_USERS = [
  { firstName: 'Priya', lastName: 'Sharma', role: ROLES.MANAGER },
  { firstName: 'Rohan', lastName: 'Mehta', role: ROLES.MANAGER },
  { firstName: 'Ananya', lastName: 'Iyer', role: ROLES.HR },
  { firstName: 'Karan', lastName: 'Verma', role: ROLES.EMPLOYEE },
  { firstName: 'Sneha', lastName: 'Kapoor', role: ROLES.EMPLOYEE },
  { firstName: 'Arjun', lastName: 'Nair', role: ROLES.EMPLOYEE },
  { firstName: 'Divya', lastName: 'Rao', role: ROLES.EMPLOYEE },
  { firstName: 'Vikram', lastName: 'Singh', role: ROLES.EMPLOYEE },
  { firstName: 'Neha', lastName: 'Joshi', role: ROLES.EMPLOYEE },
  { firstName: 'Aditya', lastName: 'Kulkarni', role: ROLES.EMPLOYEE },
];

async function main() {
  await mongoose.connect(env.MONGO_URI);

  const organization = await Organization.findOne({ name: ORG_NAME });
  if (!organization) {
    throw new Error(`Organization "${ORG_NAME}" not found`);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, PASSWORD_SALT_ROUNDS);
  const created = [];

  for (const demo of DEMO_USERS) {
    const email = `${demo.firstName}.${demo.lastName}@myrainc.demo`.toLowerCase();

    const existing = await User.findOne({ email });
    if (existing) {
      console.log(`Skipping ${email} — already exists`);
      continue;
    }

    const user = await User.create({
      organization: organization._id,
      firstName: demo.firstName,
      lastName: demo.lastName,
      email,
      passwordHash,
      role: demo.role,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isActive: true,
    });

    created.push(user);
    console.log(`Created ${user.email} (${user.role})`);
  }

  console.log(`\nDone. Created ${created.length} user(s). Password for all: ${DEMO_PASSWORD}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
