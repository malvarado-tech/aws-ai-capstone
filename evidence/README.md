# Evidencia de ejecución del capstone

Salida **real** de los comandos, capturada contra AWS, que prueba que cada sesión se ejecutó. La
rúbrica ([`../instructor/EVALUATION_RUBRIC.md`](../instructor/EVALUATION_RUBRIC.md)) pide evidencia de
pruebas exitosas, de trazas de X-Ray y de costos; esto lo cubre en texto en vez de capturas de
pantalla, que no se pueden versionar, diffear ni volver a generar.

```bash
bash evidence/capture.sh          # todo lo que esté desplegado
bash evidence/capture.sh S01      # una sesión
bash evidence/capture.sh env      # sólo entorno + gate
```

Cada archivo abre con un encabezado reproducible: timestamp UTC, stack, región y **el comando exacto**
que lo generó. Se puede volver a correr y diffear.

## Qué prueba cada archivo

### `00-entorno/`

| Archivo | Qué prueba |
|---|---|
| `identidad-aws.txt` | contra qué cuenta y con qué rol se trabajó |
| `versiones.txt` | SAM, AWS CLI, Node, Python y pip (Python **3.12**, igual que `Runtime: python3.12`) |
| `stack-resources.txt` | inventario completo de recursos del stack, con su estado |
| `stack-outputs.json` | las URLs y nombres que consumen el frontend y los scripts |
| `stack-estado.txt` | `CREATE_COMPLETE`/`UPDATE_COMPLETE` y fechas |
| `validate-all.txt` | el gate del repo completo: estático + CRUD E2E + features de IA |

### `S00-base/` — base CRUD serverless

| Archivo | Qué prueba |
|---|---|
| `01-lambda-router.json` | runtime `nodejs22.x`, 1024 MB, 30 s, `Tracing: Active` |
| `02-function-url.json` | `AuthType: NONE` + CORS — el frente HTTP **sin API Gateway** |
| `03-dynamodb-tabla.json` | `PAY_PER_REQUEST`, clave `productId`, sin índices |
| `04-dynamodb-conteo-real.txt` | conteo por `Scan` (el `ItemCount` de `describe-table` va ~6 h atrasado) |
| `05-iam-rol-router.json` | rol generado por SAM, boundary aplicado, confiado sólo a `lambda.amazonaws.com` |
| `06-iam-politicas-router.json` | **mínimo privilegio**: 10 acciones de DynamoDB, sólo sobre *nuestra* tabla |
| `07-iam-managed-router.txt` | únicamente las managed de logs y X-Ray |
| `08-crud-e2e.txt` | los 5 endpoints: GET · POST · GET/{id} · PUT/{id} · DELETE/{id} |
| `09-cors-headers.txt` | **un solo** `Access-Control-Allow-Origin` con `Origin` presente |
| `10-s3-inventario.txt` | los 10 objetos publicados y su tamaño |
| `11-s3-politica-publica.json` | la policy pública que permite que CloudFront lea el bucket |
| `12-frontend-http.txt` | CloudFront sirve `index.html`, `env-config.js` y las 4 fotos con `image/jpeg` |
| `13-cloudfront.json` | estado, origen, `redirect-to-https` y la reescritura SPA 403/404 → 200 |
| `14-cloudwatch-loggroups.txt` | log groups y su retención |
| `15-xray-trazas.txt` | trazas **acotadas a nuestras funciones** (ver caveat abajo) |

### `S01-rekognition-labels/` — Rekognition `DetectLabels`

| Archivo | Qué prueba |
|---|---|
| `01-lambda-config.json` | `python3.12`, `LABEL_MIN_CONFIDENCE=80`, `LABEL_MAX_LABELS=15` |
| `02-function-url.txt` | la Function URL propia de la sesión (`EnrichLabelsUrl`) |
| `03-iam-minimo-privilegio.txt` | las **tres** políticas: DynamoDB por tabla, `rekognition:DetectLabels` por **acción**, `s3:GetObject` por bucket |
| `04-detect-labels-por-producto.json` | la respuesta cruda de la Lambda para los 4 productos |
| `05-detect-labels-resumen.txt` | las etiquetas y su confianza, legibles |
| `06-dynamodb-ailabels.json` | el write-back: `aiLabels` + `aiLabelsRaw` con `confidence` como `N` |
| `07-cobertura-ailabels.txt` | 4 de 4 productos enriquecidos |
| `08-cloudwatch-logs.txt` | el log group de la función y sus últimos eventos |

### `S02-moderation-alttext/` — `DetectModerationLabels` + alt-text

| Archivo | Qué prueba |
|---|---|
| `01-lambda-config.json` | `python3.12`, `MODERATION_MIN_CONFIDENCE=60` (más bajo que el 80 de S01, a propósito) |
| `02-function-url.txt` | la Function URL propia de la sesión (`ModerateImageUrl`) |
| `03-iam-dos-acciones.txt` | **dos** acciones de Rekognition, no `rekognition:*` — comparar con `S01/03-…`: ese rol **no** puede moderar |
| `04-moderate-por-producto.json` | la respuesta cruda de la Lambda para los 4 productos |
| `05-veredictos-y-alttext.txt` | `APPROVED`/`FLAGGED` y el alt-text generado, legibles |
| `06-taxonomia-moderacion-umbral-0.txt` | las **52 categorías** de moderación y cuánto puntúa cada foto (modelo 7.0) |
| `07-dynamodb-moderacion.json` | el write-back: `moderationStatus` + `moderationFlags` + `altText` |
| `08-cobertura-moderacion.txt` | 4 de 4 productos moderados y con alt-text |
| `09-cloudwatch-logs.txt` | el log group de la función y sus últimos eventos |

### `S03-comprehend-sentiment/` — Comprehend `DetectSentiment`

| Archivo | Qué prueba |
|---|---|
| `01-lambda-config.json` | `python3.12`, sin variables de umbral (esta API **no tiene** knobs) |
| `02-function-url.txt` | la Function URL propia de la sesión (`AnalyzeSentimentUrl`) |
| `03-iam-pipeline-dos-acciones.txt` | `DetectDominantLanguage` **+** `DetectSentiment` — la feature son dos llamadas |
| `04-casos-de-sentimiento.txt` | 5 casos: positiva es, negativa **en** (idioma detectado solo), negación, mixta y factual |
| `05-agregado-por-producto.json` | el agregado de las 8 reseñas del seed, con `averageScores` |
| `06-agregado-independiente-del-orden.txt` | **la prueba que encontró el bug**: mismas reseñas, dos órdenes, mismo veredicto |
| `07-dynamodb-sentimiento.json` | el write-back: `reviewSentiment` + `reviewSentimentCounts` + `reviewSentimentScores` |
| `08-cobertura-sentimiento.txt` | 4 de 4 productos con sentimiento agregado |
| `09-cloudwatch-logs.txt` | el log group de la función y sus últimos eventos |

`04-…` es el argumento de por qué ML y no reglas: *"No está nada mal"* sale `POSITIVE` con 0.9418 pese al
"no", y una lista de palabras prohibidas lo habría marcado negativo. `06-…` documenta que el agregado ya
**no** depende del orden de las reseñas — ver
[`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md#11).

### `S04-translate-multilang/` — Amazon Translate

| Archivo | Qué prueba |
|---|---|
| `01-lambda-config.json` | `python3.12`, `CATALOG_SOURCE_LANG=es`, `MIN_LANG_CONFIDENCE=0.60` |
| `02-function-url.txt` | la Function URL propia de la sesión (`TranslateCatalogUrl`) |
| `03-iam-dependencia-downstream.txt` | `translate:TranslateText` **+** `comprehend:DetectDominantLanguage` — Translate llama a Comprehend con **este** rol |
| `04-deteccion-de-idioma.txt` | la confianza real por producto: el vestido da **`pt` 0.45–0.51**, los otros `es` 0.79–0.98 |
| `05-traducciones.json` | ES→EN y ES→ES de los 4 productos, respuesta cruda |
| `06-resumen-traducciones.txt` | lo mismo legible, con `sourceLanguage` / `fallback` / `omitido` |
| `07-dynamodb-translations.json` | el mapa anidado `translations.{en,es}.{name,description}` |
| `08-invariante-es-sin-reescribir.txt` | **`translations.es` == `name`** (`reescritos: 0`) |
| `09-cobertura-translations.txt` | 4 de 4 productos traducidos |
| `10-cloudwatch-logs.txt` | el log group de la función y sus últimos eventos |

### `S05-polly-voice/` — Amazon Polly

| Archivo | Qué prueba |
|---|---|
| `01-lambda-config.json` | `python3.12`, `AUDIO_BUCKET` apuntando a stack name |
| `02-function-url.txt` | la Function URL propia de la sesión (`SynthesizeVoiceUrl`) |
| `03-audio-bucket-config.json` | lifecycle rule (auto-delete after 7 days) + no versioning |
| `04-bucket-private.txt` | `BlockPublic…: true` (los 4), sin bucket policy (privado) |
| `05-iam-permisos.txt` | `polly:SynthesizeSpeech` (Resource `*`) + `S3CrudPolicy` acotado al bucket de audio |
| `06-audios-generados-es-en.json` | 4 productos × 2 idiomas, presigned URLs (1 hora) |
| `07-resumen-voces.txt` | lo mismo legible (Lupe para ES, Joanna para EN) |
| `08-s3-objetos-audio.txt` | objetos `.mp3` en el bucket y su tamaño |
| `09-cobertura-audio.txt` | 4 de 4 productos con `audioKey` en DynamoDB |
| `10-cloudwatch-logs.txt` | el log group de la función y sus últimos eventos |

Polly es **texto→voz (TTS)**, no Transcribe (voz→texto, STT). Las voces neuronales suenan naturales. Las
presigned URLs son el patrón seguro: el bucket está 100% privado, el acceso es por token temporal. La
regla de ciclo de vida es FinOps: el audio de demo no se acumula, se auto-borra a los 7 días. Dimension
de Responsible AI: accesibilidad real para personas con discapacidad visual (D4).

`04-…` es la medición que motivó el umbral, y `08-…` el invariante que el bug rompía: la traducción
`es→es` devolvía *"Vestido midi con estampado floral"* y **sobrescribía el nombre canónico**. Detalle en
[`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md#13); el `AccessDenied` de Comprehend disparado
por Translate, en [#12](../docs/TROUBLESHOOTING.md#12).

`S02/06-…` es lo que justifica el umbral con datos: la señal de moderación más alta en fotos de catálogo
normales es **0.95 %**, contra un umbral de 60. Y ojo con `05-…`: los cuatro dan `APPROVED`, así que esa
evidencia **no cubre la rama `FLAGGED`** — el procedimiento para ejercitarla está en
[`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md#9), junto con el bug de `Decimal` que sólo
aparece en ese camino.

`S01/03-…` es el punto pedagógico de D5: `rekognition:DetectLabels` lleva `Resource: "*"` **porque las APIs
`Detect*` no tienen recurso al que apuntar** — no hay ARN para "una imagen que estás por mandar". El
límite defendible es la acción: este rol puede hacer `DetectLabels` y nada más, ni `DetectFaces` ni las
APIs de colecciones de caras.

## Cómo leer los resultados de S01

Las etiquetas medidas están en `05-detect-labels-resumen.txt`. Dos merecen atención:

- **`Person 94.55`** en la foto del vestido, que es un **maniquí**.
- **`Pants 100.00` y `Vest 100.00`** en la chaqueta de mezclilla: incorrectas, y `Jacket` (la correcta)
  puntúa más bajo, 99.98.

El score de confianza mide la certeza del modelo sobre su propia salida, **no** que sea correcta. Está
desarrollado en [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md#observaciones).

## Caveats de la evidencia (leer antes de citar un número)

**X-Ray y CloudWatch son por CUENTA, no por stack.** La cuenta `281248178297` la comparte toda la
cohorte. Sin filtro, `get-trace-summaries` devuelve las trazas de los stacks de los compañeros: la
primera captura reportó 346 trazas y un HTTP 502 que resultó ser de `techmoda-ai-li-EnrichLabels`, de
otro participante. `capture.sh` ahora filtra con `service("<stack>-<Función>")`. **Cualquier métrica
agregada de esta cuenta hay que acotarla por recurso o no significa nada.**

**Los dos 404 del Router son legítimos.** Atribuidos por log: `rawPath "/"` y `rawPath "/favicon.ico"`
a las 19:33:56Z — alguien abrió la Function URL en el navegador. `/` no es una ruta y el favicon lo pide
el navegador solo.

**`capture.sh` no es de sólo lectura al 100 %.** El bloque CRUD crea un producto `__evidencia__` y lo
borra al final; el bloque S01 vuelve a llamar a Rekognition (**se cobra por imagen**, céntimos) y
reescribe `aiLabels` con el mismo valor. Nada queda modificado de forma permanente.

**El nombre del stack tiene tres fuentes que discrepan.** `capture.sh` no resuelve por su cuenta: sourcea
[`../scripts/lib/resolve-stack.sh`](../scripts/lib/resolve-stack.sh), el mismo resolver que usan
`validate-all.sh`, `status.sh` y `logs.sh`. Prueba `$STACK_NAME`, `samconfig.toml` y `techmoda-ai`, se
queda con el que **existe** y avisa si difieren — así el encabezado de cada archivo dice sobre qué stack
es la evidencia. Ver [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md#8).

## Por qué las salidas capturadas no se comitean

`.gitignore` excluye los directorios de salida y versiona **`capture.sh` y este README**. Motivo: la
evidencia contiene las **Function URLs en vivo**, y esas funciones son `AuthType: NONE` — cualquiera con
la URL puede crear y borrar productos del catálogo. Publicarlas en un repo baja la barrera a que pase.

El script sí se comitea, así que la evidencia es **reproducible** por quien tenga acceso a la cuenta,
que es la propiedad que realmente importa. Si la entrega exige adjuntarla, conviene redactar los IDs de
las Function URLs primero, o borrar el stack después de la evaluación.
