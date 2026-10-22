import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { provideStorage, getStorage } from '@angular/fire/storage';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    /**
     * অফলাইন পারসিস্টেন্স (IndexedDB, একাধিক ট্যাব সমর্থিত):
     * পড়া (তালিকা, পাসবই, শিডিউল) ইন্টারনেট ছাড়াও ক্যাশ থেকে চলে।
     * কিন্তু টাকার লেনদেন (কিস্তি আদায়, ঋণ বিতরণ, ক্যাশ ক্লোজিং) runTransaction ব্যবহার করে —
     * Firestore ট্রানজ্যাকশন অফলাইনে চলে না, তাই এগুলোর জন্য ইন্টারনেট সংযোগ আবশ্যক।
     */
    provideFirestore(() => initializeFirestore(getApp(), {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    })),
    provideAuth(() => getAuth()),
    provideStorage(() => getStorage())
  ]
};
