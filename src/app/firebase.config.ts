import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { environment } from '../environments/environment';

export const firebaseConfig = environment.firebase;

// Initialize Firebase app instance (ensures single instance)
export const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Firebase services
export const auth: Auth = getAuth(app);
export const firestore: Firestore = getFirestore(app);
export const db: Firestore = firestore; // Alias for Firestore
export const storage: FirebaseStorage = getStorage(app);

export default app;
