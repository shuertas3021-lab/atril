# Atril (versión online)

Lector de EPUB con voces en la nube, resaltados, resúmenes con Claude y cuentas de usuario.

## Cómo funcionan las cuentas

- Cada persona se registra con **su nombre, correo, una contraseña y el código de invitación** que tú le das.
- Su biblioteca (libros, portadas, resaltados, notas, documentos, prompts y ajustes) se guarda en su cuenta y aparece en todos sus dispositivos. Nadie ve la biblioteca de otra persona.
- Tú (el correo de `OWNER_EMAIL`) tienes el botón **Usuarios**: ves quién está registrado, cuánta voz e IA usó cada quien este mes y puedes darle una **contraseña temporal** a quien la olvide.
- Cada persona tiene un límite mensual de voz en la nube y de consultas a Claude; tú no tienes límite.
- Las voces del dispositivo no cuentan para el límite: siempre son gratis.

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La app completa (lo que ves en el navegador) |
| `api/tts.js` | Convierte cada frase en audio con Azure, Google o ElevenLabs |
| `kokoro-worker.js` | Genera la voz Kokoro dentro del navegador, sin servidor ni llaves |
| `api/voices.js` | Lista las voces en español de cada servicio |
| `api/ai.js` | Envía tus resaltados a Claude y devuelve la respuesta |
| `api/config.js` | Revisa la sesión y qué servicios están activos |
| `api/signup.js` | Crea cuentas nuevas (solo con el código de invitación) |
| `api/admin.js` | Panel de usuarios del dueño |
| `supabase.sql` | Crea las tablas y reglas de seguridad en Supabase (se pega una sola vez) |
| `vercel.json`, `package.json` | Configuración para Vercel (no hay que tocarlos) |

Las llaves **nunca** van en estos archivos: se guardan en Vercel como variables de entorno.

## Voces gratuitas incluidas

| Servicio | Gratis cada mes | Voces |
|---|---|---|
| Microsoft Azure (plan F0) | 500 mil caracteres (≈ 1 libro) y no cobra al pasarte: solo se detiene | Dalia, Jorge y más de México; otros países |
| Google Cloud (Chirp 3 HD) | 1 millón de caracteres (≈ 2 libros). Después cobra 30 USD por millón | Latino (EE. UU.) y España |
| Google Cloud (Neural2 / WaveNet) | 1 millón de caracteres aparte | Latino (EE. UU.) y España |
| ElevenLabs | Según tu plan (usa el modelo Flash, el más económico) | Tu biblioteca de voces |
| Voces del dispositivo | Siempre gratis | Las de tu Mac, iPhone o Edge |
| **Kokoro** (en el dispositivo) | Siempre gratis y sin límite | Dora, Alex y Santa (español latino). Se descargan unos 110 MB la primera vez y luego funcionan sin internet |

Cada frase se genera una sola vez y se guarda en el navegador y en la caché de Vercel: releer o escuchar el mismo libro en grupo no vuelve a gastar.

## Variables de entorno (Vercel → Settings → Environment Variables)

| Nombre | Ejemplo | ¿Obligatoria? |
|---|---|---|
| `SUPABASE_URL` | `https://abcd1234.supabase.co` | Sí, para cuentas |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (o la anon key) | Sí, para cuentas |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (o la service_role key) | Sí, para cuentas. **Nunca la compartas** |
| `INVITE_CODE` | `ministerio2026` | Sí. El código que das a tus amigos para registrarse |
| `OWNER_EMAIL` | `tu@correo.com` | Sí. Tu correo: te da el panel de usuarios y uso sin límite |
| `LIMIT_TTS_CHARS` | `200000` | Opcional. Caracteres de voz en la nube por persona al mes |
| `LIMIT_AI_CALLS` | `60` | Opcional. Consultas a Claude por persona al mes |
| `AZURE_SPEECH_KEY` | (Key 1 de tu recurso Speech) | Para voces de Azure |
| `AZURE_SPEECH_REGION` | `eastus` | Para voces de Azure (en minúsculas, sin espacios) |
| `GOOGLE_TTS_API_KEY` | `AIza…` | Para voces de Google |
| `ELEVENLABS_API_KEY` | `sk_…` | Para voces de ElevenLabs |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Para resúmenes con IA |

Sin las variables de Supabase, Atril funciona en modo sencillo con un código de acceso compartido (`APP_PASSWORD`) y cada quien guarda todo en su navegador.

Opcionales: `ELEVENLABS_MODEL` (por defecto `eleven_flash_v2_5`), `AI_MODEL_QUICK`, `AI_MODEL_DEFAULT`, `AI_MODEL_COMPLEX` (por defecto Haiku, Sonnet y Opus 5.5).

Después de agregar o cambiar una variable hay que volver a publicar: Vercel → Deployments → los tres puntos del último → **Redeploy**.

## Configurar Supabase (una sola vez)

1. En supabase.com crea un proyecto llamado `atril` (región East US). Guarda la contraseña de la base de datos aunque Atril no la usa.
2. **SQL Editor → New query**: pega todo el contenido de `supabase.sql` y toca **Run**. Debe decir «Success».
3. **Authentication → Sign In / Providers**: apaga **Allow new users to sign up**. Así nadie puede registrarse sin pasar por Atril y su código de invitación. Deja activado el proveedor **Email**.
4. **Authentication → URL Configuration**: en **Site URL** pon la dirección de tu Atril en Vercel.
5. **Project Settings → API Keys**: copia la **Publishable key** y la **Secret key**. En **Project Settings → Data API** (o el botón **Connect**) copia la **Project URL**.

El correo gratuito de Supabase solo envía a los miembros de tu equipo (2 por hora), por eso Atril no depende del correo: las cuentas se crean ya confirmadas. Si alguien olvida su contraseña, dale una temporal desde **Usuarios**. Si algún día quieres enlaces de recuperación por correo, configura un SMTP propio (por ejemplo Resend o Brevo) en Authentication → Emails → SMTP Settings.

## Publicar

1. **GitHub:** crea un repositorio privado llamado `atril` → «uploading an existing file» → arrastra todo el contenido de esta carpeta (incluida la carpeta `api`) → **Commit changes**.
2. **Vercel:** Add New → Project → importa `atril` → Framework Preset: **Other** → abre «Environment Variables» y agrega las de la tabla → **Deploy**.
3. Abre la dirección que te da Vercel y **regístrate tú primero** con el mismo correo de `OWNER_EMAIL`.
4. En Biblioteca → Respaldo, importa el archivo que exportaste desde la versión de Claude: se sube a tu cuenta.
5. Comparte con tus amigos la dirección y el código de invitación.

## Voz Kokoro

Kokoro es un modelo de voz de código abierto que corre en el propio dispositivo: no usa llaves, no cuenta para los límites y no le cuesta a nadie.

- Elige **Dora**, **Alex** o **Santa** en el grupo «Kokoro · gratis en este dispositivo» del selector de voz.
- La primera vez se descargan unos 110 MB (el modelo y el fonetizador de español). Después quedan guardados en el navegador.
- La velocidad depende del procesador. En una Mac con chip M o una PC reciente va casi al ritmo de la lectura; en celulares es lento y puede haber pausas entre frases. Para el iPhone conviene Azure.
- Atril genera varias frases por adelantado para evitar pausas. Si saltas a otra parte del libro, descarta lo que ya no se necesita.
- `vercel.json` activa el aislamiento entre orígenes (COOP/COEP) para que Kokoro pueda usar varios núcleos del procesador. No hay que tocarlo.

## Problemas comunes

- **«Esta voz no está configurada»**: falta la variable de ese servicio o no hiciste Redeploy.
- **«La llave de … no es válida»**: revisa que la copiaste completa. En Google, que la API «Cloud Text-to-Speech» esté habilitada.
- **Azure dice límite alcanzado**: el plan gratuito permite 20 peticiones por minuto; Atril espera y reintenta solo. Si se acabaron los 500 mil caracteres del mes, cambia a una voz de Google o del dispositivo.
- **«Las cuentas todavía no están configuradas»**: faltan `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` o `SUPABASE_SECRET_KEY`, o no hiciste Redeploy.
- **No aparece el botón Usuarios**: tu correo no coincide exactamente con `OWNER_EMAIL`.
- **«No se pudo sincronizar»**: revisa que corriste `supabase.sql` completo. Lo guardado en el dispositivo no se pierde; se sube cuando vuelva la conexión.
- **Kokoro se queda en «Generando voz…»**: la primera frase tarda mientras se descarga y prepara el modelo. Si nunca arranca, prueba en Chrome o Edge en computadora.
- **Ver errores del servidor**: Vercel → tu proyecto → Logs.
