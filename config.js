/* =====================================================================
   MARIPOSA · conexión con tu base de datos

   Este es el ÚNICO archivo que tienes que editar.
   En Supabase: Project Settings > API. Copia:
     - "Project URL"                  -> supabaseUrl
     - "Publishable key" (o "anon")   -> supabaseAnonKey

   IMPORTANTE: pega SOLO la llave pública (empieza con sb_publishable_ o eyJ...).
   NUNCA pegues aquí la llave "secret" ni la "service_role": quien la vea
   podría borrar toda tu base de datos. Esta página es pública.
   ===================================================================== */
window.MARIPOSA_CONFIG = {
  supabaseUrl: 'https://TU-PROYECTO.supabase.co',
  supabaseAnonKey: 'TU_LLAVE_PUBLICA',
  demo: false
};
