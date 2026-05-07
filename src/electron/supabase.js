const { createClient } = require('@supabase/supabase-js');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = 'https://eoyrxsctnxqilzkrjjzy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVveXJ4c2N0bnhxaWx6a3Jqanp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTc1OTUsImV4cCI6MjA5MjYzMzU5NX0.eGBjhu6ie7is17gOTz0DV9xOacwegnyk7kDD5kKInOY';

// Archivo donde guardamos la sesión
const SESSION_FILE = path.join(app.getPath('userData'), 'supabase_session.json');

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function saveSession(session) {
  try {
    if (session) {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session), 'utf8');
    } else {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    }
  } catch (e) {}
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Al arrancar restaurar sesión guardada
const savedSession = loadSession();
if (savedSession) {
  supabase.auth.setSession({
    access_token: savedSession.access_token,
    refresh_token: savedSession.refresh_token
  }).catch(() => saveSession(null));
}

// Escuchar cambios de sesión y guardar/borrar
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
    saveSession(session);
  } else if (event === 'SIGNED_OUT') {
    saveSession(null);
  }
});

module.exports = { supabase };