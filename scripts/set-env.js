const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Sanitizer to strip stray quotes, commas, or semicolons often copied from JS objects
const clean = (val) => {
  if (!val) return '';
  return val.trim().replace(/^["']|["',;]+$/g, '').trim();
};

const createEnvContent = (isProd) => `export const environment = {
  production: ${isProd},
  firebase: {
    apiKey: "${clean(process.env.FIREBASE_API_KEY)}",
    authDomain: "${clean(process.env.FIREBASE_AUTH_DOMAIN)}",
    projectId: "${clean(process.env.FIREBASE_PROJECT_ID)}",
    storageBucket: "${clean(process.env.FIREBASE_STORAGE_BUCKET)}",
    messagingSenderId: "${clean(process.env.FIREBASE_MESSAGING_SENDER_ID)}",
    appId: "${clean(process.env.FIREBASE_APP_ID)}",
    measurementId: "${clean(process.env.FIREBASE_MEASUREMENT_ID)}"
  }
};
`;

const environmentsDir = path.resolve(__dirname, '../src/environments');

if (!fs.existsSync(environmentsDir)) {
  fs.mkdirSync(environmentsDir, { recursive: true });
}

// Write both development and production environment files
fs.writeFileSync(
  path.join(environmentsDir, 'environment.development.ts'),
  createEnvContent(false),
  'utf-8'
);

fs.writeFileSync(
  path.join(environmentsDir, 'environment.ts'),
  createEnvContent(true),
  'utf-8'
);

console.log('✓ Angular environment files successfully updated from .env');
