# 📺 8bits Channel — Visor IPTV

Visor web de los canales públicos de [iptv-org/iptv](https://github.com/iptv-org/iptv),
**ordenados por país y por enfoque (categoría)**, que **elimina automáticamente los
canales no accesibles**.

## Cómo funciona

1. **Verificación en el servidor** (`scripts/build.mjs`): descarga los datos de la
   [API de iptv-org](https://github.com/iptv-org/api) (canales, streams, países,
   categorías y logos) y comprueba cada stream:
   - responde con HTTP 2xx (enviando el `User-Agent`/`Referer` que exige cada stream),
   - el contenido es realmente una lista `#EXTM3U`,
   - si es una lista maestra, su primera variante también responde,
   - si tiene cabecera CORS (necesaria para reproducirse en el navegador).

   Todo lo que falla se descarta. El resultado es `public/data/channels.json`
   y una lista `public/data/playlist.m3u` (solo canales que funcionan) para VLC/Kodi.
   Se excluyen canales para adultos y canales cerrados.

2. **Eliminación en el navegador** (`public/app.js`): si al reproducir un stream
   falla (error de red, manifiesto inválido o 20 s sin arrancar), se marca como roto,
   se prueba automáticamente la siguiente fuente del canal y, si no queda ninguna,
   el canal desaparece de la lista. Se recuerda 3 días en `localStorage` (y se puede
   restaurar desde la barra lateral). Si estás sin conexión no se elimina nada.

3. **GitHub Actions** (`.github/workflows/update.yml`): repite la verificación
   todos los días y publica el visor en GitHub Pages.

## Funciones del visor

- Agrupar por **país** (subgrupos por enfoque) o por **enfoque** (subgrupos por país).
- Filtros por país y por una o varias categorías, con contadores; búsqueda por nombre.
- «Solo canales reproducibles en el navegador»: oculta streams sin CORS, `http://`
  (bloqueados en páginas https), DASH o que necesitan cabeceras especiales.
  Desactívalo para verlos y abrirlos en un reproductor externo.
- Selector de fuente cuando un canal tiene varias, logos y calidad.
- Diseño adaptable a móvil.

## Publicarlo en GitHub Pages

1. Fusiona esta rama en `main`.
2. En **Settings → Pages → Build and deployment → Source**, elige **GitHub Actions**.
3. En **Actions → Verificar canales y publicar**, pulsa **Run workflow**
   (después se ejecuta solo cada día). La verificación completa tarda entre
   15 y 60 minutos.

## Uso local

```bash
npm run build        # verifica todos los streams (lento)
npm run build:quick  # sin verificar, solo para probar la interfaz
npm run serve        # http://localhost:8080
npm test
```

Opciones de `scripts/build.mjs`: `--limit N`, `--concurrency N`, `--timeout MS`,
`--iptv-dir RUTA` (clon de iptv-org/iptv para asignar país a streams sin canal),
`--no-check`, `--min-working N` (aborta si funcionan menos de N streams, por defecto 500,
para no publicar un visor vacío si falla la red).

## Aviso

Este proyecto no aloja ningún stream: solo enlaza a las URLs públicas recopiladas por
iptv-org. La disponibilidad depende de cada emisora (algunos canales tienen bloqueo
geográfico).
