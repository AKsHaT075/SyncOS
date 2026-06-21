const mongoose = require('mongoose');
const env = require('../../src/config/env');

async function connectTestDb() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }
}

async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

module.exports = { clearTestDb, connectTestDb, disconnectTestDb };
