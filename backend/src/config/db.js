const mongoose = require('mongoose');
const env = require('./env');

async function connectMongo() {
  mongoose.set('strictQuery', true);

  await mongoose.connect(env.MONGO_URI, {
    autoIndex: env.NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 10000,
  });

  return mongoose.connection;
}

module.exports = { connectMongo };