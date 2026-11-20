import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getDatabase, ref, set, update, onValue } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAGZz4BHaC3VG-7sLn25D_8rg6HT9M7HVI",
  authDomain: "oee-cnc.firebaseapp.com",
  databaseURL: "https://oee-cnc-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "oee-cnc",
  storageBucket: "oee-cnc.firebasestorage.app",
  messagingSenderId: "291017699697",
  appId: "1:291017699697:web:4aded5d1559004ee2dc6d0",
  measurementId: "G-88R0XC5KFR"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const rootRef = ref(db, "cnc_oee_project");

export { db, rootRef, ref, set, update, onValue };