# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este repo

Material educativo (Bootcamp Institute / AWS re/Start, pista **AI Practitioner AIF-C01**): un capstone
de e-commerce serverless ("TechModa") al que se le agregan capacidades de IA de AWS **una sesión de
~1 h a la vez**. No es un producto: es un artefacto de enseñanza que además tiene que desplegarse de
verdad en una cuenta AWS.

Las 12 sesiones viven en `sessions/S00…S11` y cada una es autocontenida: `GUIA.md` (concepto + paso a
paso + checklist + costo + cleanup) + `functions/<nombre>/app.py` + `template-snippet.yaml`.

La documentación está en **español** (guías, comentarios de scripts, mensajes de consola). Mantené ese
idioma al editar guías o agregar sesiones; el código y los identificadores están en inglés.

## Comandos

```bash
# Validación completa paso por paso (lo primero que hay que correr)
bash scripts/validate-all.sh --static    # todo lo que no necesita AWS
bash scripts/validate-all.sh --aws       # solo las pruebas contra el stack desplegado
bash scripts/validate-all.sh             # ambos

# Templates suelto
sam validate --lint -t template.yaml
sam validate --lint -t template.sandbox.yaml
sam validate --lint -t template.full.yaml

# Entorno y observabilidad
bash scripts/bootstrap.sh                # paso 0 de cada día: deploy sandbox + seed (idempotente)
bash scripts/status.sh                   # estado del stack + Function URLs + conteo DDB
bash scripts/logs.sh [list|create|get|update|delete] [--tail|--errors|--since 1h|--filter TXT]
bash ai/seed/seed-products.sh            # re-siembra los 4 productos vía la Function URL del router

# Frontend (en frontend/)
npm run dev | build | lint | typecheck
npx vitest run                           # una pasada
npx vitest run src/lib/api.test.ts       # un archivo
npx vitest run -t "nombre del test"      # un test
```

- **`validate-all.sh` es el gate del repo.** No usa `set -e` a propósito: corre todo y da un resumen
  `N OK / N fallo(s) / N omitido(s)`, con el comando exacto para reproducir cada `✗`. Exit 1 si hay
  fallos. Corrélo después de tocar templates, snippets, docs o el frontend.
- **No hay tests de Python ni linter de Python.** Las Lambdas de IA se validan con `py_compile`
  (sintaxis) en `validate-all.sh` y con el `curl` de cada `GUIA.md` (comportamiento). Los únicos tests
  reales son los de vitest del frontend.
- **Python local debe ser 3.12**, igual que el `Runtime: python3.12` de las Lambdas de IA; con 3.11
  `sam build` falla con un error de `PythonPipBuilder` difícil de interpretar. Está fijado en
  `.devcontainer/devcontainer.json` (junto con node 22, que coincide con `nodejs22.x`).
- Para desarrollo local del frontend contra un backend ya desplegado: `cp frontend/.env.example
  frontend/.env` y pegá la salida `ApiUrl` del stack en `VITE_API_URL`.

## Arquitectura

**Base (S0):** DynamoDB `${StackName}-Products` (`productId` como HASH, PAY_PER_REQUEST) + **una**
Lambda router Node.js + frontend React/Vite en S3/CloudFront.

**Capas de IA (S1–S9):** 9 Lambdas Python 3.12 + boto3, cada una con **su propia Function URL**, que
llaman a un servicio de IA administrado y escriben el resultado de vuelta en el mismo item de
DynamoDB (`aiLabels`, `sentiment`, `translations`, `audioUrl`, `aiDescription`, `embedding`…). El
patrón central del capstone es **una Lambda = un servicio de IA = un rol**.

Dos decisiones dominan el diseño; **leé [`docs/IAM.md`](docs/IAM.md) antes de agregar cualquier
función:**

1. **IAM de mínimo privilegio por función.** Cada Lambda declara sus `Policies:` y **SAM le crea su
   rol**. No hay rol preexistente que referenciar. Nunca pongas `Role:` junto a `Policies:` — son
   mutuamente excluyentes en SAM y tus `Policies` se ignoran **en silencio**.
2. **Sin API Gateway.** El frente HTTP son **Lambda Function URLs** (`AuthType: NONE`, CORS `*`); el
   CRUD usa un router con una sola URL. Es más simple de desplegar y de explicar.

**El router (`functions/router/index.js`)** existe justamente porque no hay API Gateway: se empaqueta
con `CodeUri: functions/` + `Handler: router/index.handler`, así puede `require('../list-items')` y
reusar los 5 handlers CRUD sin duplicar lógica. Parsea el payload v2.0 de Function URL
(`requestContext.http.method`, `rawPath`, body base64), normaliza el path y **reconstruye
`pathParameters.id`** para que los handlers CRUD funcionen tal cual. Con una sola base URL el frontend
(`frontend/src/lib/api.ts`) no cambia.

**Tres templates, elegí según el caso:**

| Template | Contenido | Cuándo |
|---|---|---|
| `template.yaml` | solo S0 (+ CloudFront) | ruta progresiva: pegar el `template-snippet.yaml` de cada sesión |
| `template.sandbox.yaml` | base + S1/S2/S3/S5 + AudioBucket, sin CloudFront | lo que usa `bootstrap.sh` (levanta rápido) |
| `template.full.yaml` | base + S1–S8 + gobernanza (tags de costo, log group) | demo o revisar el resultado final |

**La ruta progresiva es manual y en dos partes.** El estudiante pega el bloque del
`template-snippet.yaml` dentro de `Resources:` de `template.yaml`, y **además** agrega a mano el
`Outputs:` que el propio snippet documenta en su comentario de cierre. `validate-all.sh` reproduce
exactamente ese splice (inserta el snippet antes de `\nOutputs:`) y corre `sam validate --lint` sobre
el resultado, así que un snippet que no encaja se detecta sin desplegar.

**Lo que el stack NO maneja** (a propósito, es parte del contenido de D5):
`sessions/S09-.../create-guardrail.sh` crea el guardrail de Bedrock con **tu** identidad de CLI —
`bedrock:CreateGuardrail` no está en el rol de ninguna Lambda porque crear un guardrail es
administración de una sola vez, no runtime. `sessions/S10-.../enable-bedrock-logging.sh` configura el
model invocation logging, que es **por cuenta/región** y necesita un rol de entrega que Bedrock asuma;
el script imprime los comandos para crearlo si falta.

## El permissions boundary hardcodea una cuenta

Los tres templates traen esto en `Globals.Function`:

```yaml
PermissionsBoundary: arn:aws:iam::281248178297:policy/techmoda-capstone-boundary
```

La policy de deploy de los workspaces de la cohorte solo permite `iam:CreateRole` si el rol **nace**
con ese boundary. Consecuencia práctica: **el capstone ya no se despliega tal cual en cualquier
cuenta.** En otra cuenta hay que crear un boundary equivalente y cambiar el ARN, o borrar esa línea.
No cambia los permisos efectivos de las funciones — sus `Policies:` por función ya están dentro del
techo (DDB/S3 `techmoda-*`, servicios de IA, `bedrock:InvokeModel`, logs/X-Ray).

Varias frases de `docs/IAM.md`, `docs/SANDBOX-COMPAT.md` §2 y los `GUIA.md` todavía dicen "cualquier
cuenta con `iam:CreateRole`", que era cierto antes del commit `615dffe`. **`validate-all.sh` no chequea
account IDs hardcodeados**, así que esa divergencia no la agarra nada automático: si tocás el boundary,
actualizá la doc a mano.

## Despliegue

Región **us-east-1**, stack **`techmoda-ai`**. Verificá primero que estás autenticado
(`aws sts get-caller-identity`) y corré `bash scripts/validate-all.sh --static`.

### Primer despliegue

```bash
cp samconfig.us-east-1.example samconfig.toml   # una vez; samconfig.toml está en .gitignore
bash scripts/deploy-all.sh                      # backend + npm install + build + frontend a S3
```

`deploy-all.sh` orquesta los tres pasos; los individuales son `scripts/deploy.sh` (backend),
`scripts/build-frontend.sh` y `scripts/deploy-frontend.sh`. Toma ~3–5 min, más 15–20 min la primera
vez que CloudFront propaga (mientras tanto la API ya responde por `curl`).

### Backend

`scripts/deploy.sh` hace `sam build && sam deploy`. Si existe `samconfig.toml` usa esa config; si no,
pasa las flags explícitas:

```bash
sam deploy --stack-name techmoda-ai --region us-east-1 \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --resolve-s3 --no-confirm-changeset
```

Ninguna de las dos capabilities es opcional: `CAPABILITY_AUTO_EXPAND` por el Transform de SAM, y
`CAPABILITY_IAM` porque **el stack crea roles** (uno de mínimo privilegio por función).

Los templates **no declaran `Parameters:`** — no hay nada que sobreescribir con
`--parameter-overrides`. Con `template.full.yaml` o `template.sandbox.yaml` hay que pasar `-t`
**tanto a `build` como a `deploy`**.

### Frontend

`scripts/deploy-frontend.sh` lee los outputs del stack (`FrontendBucketName`, `ApiUrl`), inyecta la URL
vía `scripts/inject-env.sh` y hace `aws s3 sync --delete`. La inyección genera `dist/env-config.js`
desde `public/env-config.js.template` reemplazando `%%VITE_API_URL%%`: es configuración en **runtime**,
no horneada en el bundle, y `index.html` carga ese script **antes** del bundle para que `window.__ENV`
exista. `api.ts` resuelve `window.__ENV` → `import.meta.env` → fallback. Detalle en
[`docs/RUNTIME_CONFIG.md`](docs/RUNTIME_CONFIG.md). Requiere backend desplegado y `frontend/dist/`
(`npm run build`).

### Paso 0 de cada día (entorno efímero)

```bash
bash scripts/bootstrap.sh
```

Idempotente y seguro de correr siempre: `sam build && sam deploy` de `template.sandbox.yaml`,
re-siembra los 4 productos e imprime las Function URLs. Si el sandbox no se recicló, `sam deploy` no
detecta cambios y termina en segundos. El plan día por día está en
[`SESSION-PLAN.md`](SESSION-PLAN.md). **El bootstrap no restituye enriquecimientos**: si el entorno se
recicló entre S07 y S08, hay que re-correr el endpoint de indexado de embeddings de S07.

### Verificar

```bash
bash scripts/status.sh
API=$(aws cloudformation describe-stacks --stack-name techmoda-ai --region us-east-1 \
       --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
curl -s "${API%/}/products" | python3 -m json.tool    # debe listar los 4 productos
```

`ApiUrl` termina en `/` y **no** lleva `/Prod` (es una Function URL, no API Gateway) — de ahí el
`${API%/}` en todos los ejemplos.

### Cleanup

```bash
bash scripts/delete-all.sh          # pide confirmación explícita ("si"); borra el stack completo
bash scripts/fix-failed-delete.sh   # si quedó en DELETE_FAILED por buckets S3 no vacíos
```

Regla FinOps del capstone: ningún recurso de IA queda encendido entre sesiones más de lo necesario.
Cada `GUIA.md` trae su cleanup específico; detalles en
[`docs/COST_AND_CLEANUP.md`](docs/COST_AND_CLEANUP.md).

## Las 12 sesiones corren todas

Con roles propios de mínimo privilegio, **las 12 sesiones son ejecutables por el estudiante** — ya no
hay una "Pista B" que solo se pueda demostrar. El único requisito **externo** que queda es habilitar
**Bedrock → Model access** en la consola, en la región del deploy (es un setting **por región**), para
S06–S09: Anthropic **Claude Haiku 4.5** y Amazon **Titan Embeddings v2**. Si S06–S09 dan
`AccessDeniedException`, ese es el primer sospechoso, **no** las políticas IAM.

## Al agregar una sesión o función

Checklist completo en [`docs/IAM.md`](docs/IAM.md) y `docs/SANDBOX-COMPAT.md`. En resumen:

- `Policies:` acotadas (por tabla, por bucket, por ARN de modelo, o **por acción** si el servicio no
  admite ARN). **Sin `Role:`**. Sin comodines de servicio (`bedrock:*`, `rekognition:*`…).
- HTTP → `FunctionUrlConfig`; nunca `Events: Type: Api` ni `AWS::Serverless::Api`.
- `Runtime: python3.12` como override del global (`nodejs22.x`), `Handler: app.lambda_handler`.
- El handler saca sus parámetros de `rawPath` / `queryStringParameters` / body (no de
  `pathParameters`, que no existe en Function URLs). Copiá el helper `_path_id()` de una sesión
  existente.
- Output de la URL: `!GetAtt <LogicalId>FunctionUrl.FunctionUrl` — SAM nombra el recurso
  `<LogicalId>Url` pero el atributo se lee así.
- El snippet cierra con un comentario que dicta el bloque `Outputs:` y un `curl` de ejemplo.
- Cada `GUIA.md` cierra con estimación de costo (marcada *verificar contra precios oficiales*) y
  bloque de cleanup.
- Agregá la feature a `probar_ia` en `validate-all.sh` y a `sessions/S11-.../demo.sh`.
- Corré `bash scripts/validate-all.sh --static`.

## Gotchas verificados

- **El nombre del stack no se hardcodea ni se lee de una sola fuente.** Hay tres que discrepan
  (`$STACK_NAME` que asigna el entorno del workshop y que está **vacío en shells no interactivos**,
  `samconfig.toml`, y el `techmoda-ai` de la doc). Los scripts de lectura sourcean
  [`scripts/lib/resolve-stack.sh`](scripts/lib/resolve-stack.sh), que se queda con el que **existe** en
  CloudFormation. **No agregues un cuarto resolver**: tener uno distinto por script *era* el bug.
  Quedan afuera a propósito los scripts de borrado (resolver hacia `techmoda-ai` en una cuenta
  compartida podría apuntar un `delete` al stack de otro) y `validate-all.sh --static` (el resolver
  llama a CloudFormation y `--static` tiene que correr sin credenciales).
- **El nombre del bucket se deriva del stack**, no se elige: `!Sub ${AWS::StackName}-frontend` / `-audio`.
  S3 es namespace **global**, así que el nombre del stack es lo único que hay que personalizar para no
  chocar con otro participante — no hay que editar el template.
- **DynamoDB no acepta `float`** vía el resource de boto3: convertí a `Decimal(str(v))` antes del
  `update_item`, o el handler crashea con `TypeError: Float types are not supported`. Pasó con los
  `Confidence` de Rekognition en S01.
- Las Lambdas CRUD usan `nodejs22.x` (`nodejs18.x` está deprecada); las de IA, `python3.12`.
- Los IDs de modelo Bedrock viven en variables de entorno (`BEDROCK_MODEL_ID`, `EMBED_MODEL_ID`) y S06
  usa la **Converse API**, agnóstica al proveedor → cambiar de modelo no requiere tocar código.
  Estas Lambdas usan la integración de `boto3` `bedrock-runtime`, que exige IDs **versionados**: el
  default pineado es `anthropic.claude-haiku-4-5-20251001-v1:0`. El alias de la Claude API
  (`claude-haiku-4-5` a secas) **no sirve acá** — `bedrock-runtime` lo rechaza con
  `ValidationException`. Con perfiles de inferencia cross-region el ID lleva prefijo `us.` y hay que
  permitir el ARN `inference-profile/*` **además** de `foundation-model/*` (el ARN de foundation model
  tiene el campo de cuenta vacío; el de inference profile sí la lleva). Si una demo falla con 404 /
  "model not found", revisá el ID antes de debuggear otra cosa.
- Los model IDs viven en **cinco** lugares que tienen que coincidir: `template.full.yaml`, el
  `template-snippet.yaml` de S06 y de S08, y el default de cada `app.py`. `validate-all.sh` chequea que
  no divergan y que el ID termine en `-vN:M`.
- **Condiciones IAM con `*` van con `StringLike`/`ArnLike`, nunca `StringEquals`/`ArnEquals`.** Estos
  últimos tratan el `*` como literal: la política se crea sin error y deniega todo. Entra en el examen.
- **El contrato de campos es camelCase** (`productId`, `imageUrl`, `stock`) de punta a punta.
  `validate-all.sh` falla si aparece `product_id`/`image_url` en `frontend/src`.
- `_response()` está duplicado en los 9 handlers de IA y el helper `_path_id()` en 5. Es
  **deliberado**: cada sesión tiene que poder leerse aislada. No lo factorices a un `ai/shared/`.
- Los `imageUrl` del seed son literalmente `REEMPLAZAR_CON_TU_IMAGEN: s3://…`; los handlers de visión
  devuelven 422 hasta que subís una imagen real y actualizás el producto. No es un bug. Ojo: el S01
  `GUIA.md` y `sessions/README.md` mandan a subirla a `s3://techmoda-ai-frontend/assets/` —
  **ese literal es el bucket del stack `techmoda-ai`, que no es el tuyo**. Va a
  `s3://<tu-stack>-frontend/`, y mejor a `frontend/public/products/` (`deploy-frontend.sh` termina en
  `sync --delete`, que borra lo que subiste a mano; ver `frontend/public/products/CREDITS.md`).
- `validate-all.sh` exige **una sola región** en todo el repo — cualquier mención de la región vieja
  (`us-`+`west-2`, de antes de la migración) es un fallo, y este archivo tampoco está exceptuado — y **prohíbe
  nombrar el rol compartido del sandbox re/Start** (el `Lab`+`Role` del modelo IAM viejo) en docs
  fuera de una allowlist de 5 archivos históricos — que **no incluye este archivo**, así que escribir
  ese nombre acá rompe el gate. Es intencional: existe porque un refactor dejó ~130 menciones vivas
  que mandaban al estudiante a seguir pasos que ya no aplicaban.

## Evidencia y troubleshooting

- **[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)** — bitácora de los problemas reales que
  aparecieron ejecutando el capstone, con causa raíz, arreglo y el gate que los previene. Si algo
  falla, mirá acá antes de debuggear de cero: el nombre de bucket global, el doble header de CORS que
  `curl` no detecta, la falta de pip, las imágenes rotas por `--delete`. **Al resolver un problema
  nuevo, agregá su entrada** — el formato es síntoma / cómo se diagnosticó / causa raíz / arreglo.
- **[`evidence/capture.sh`](evidence/capture.sh)** — regenera la evidencia de ejecución (salida real de
  los comandos, no capturas de pantalla). Se versionan el script y `evidence/README.md`; las salidas
  están en `.gitignore` porque contienen las Function URLs en vivo y son `AuthType: NONE`. Al agregar
  una sesión, agregá su bloque de captura.

## Documentación: qué es autoritativo y qué es capa legacy

Autoritativo y al día: `README.md`, `SESSION-PLAN.md`, `sessions/README.md`, cada
`sessions/S*/GUIA.md`, `docs/IAM.md`, `docs/SANDBOX-COMPAT.md`, `docs/COST_AND_CLEANUP.md`,
`docs/RUNTIME_CONFIG.md`, `scripts/README.md`.

Capa **heredada del capstone base** (el CRUD de 5 Lambdas con API Gateway, antes de la pista de IA):
`README-BASE-SERVERLESS.md`, `CAPSTONE_OVERVIEW.md`, `QUICKSTART.md`, `AWS_CREDENTIALS_SETUP.md`,
`docs/ARCHITECTURE.md`, `docs/TESTING_GUIDE.md`, `docs/specs/*`, `docs/prompts/*`, `instructor/*`.
Se adaptaron con un **banner de traducción arriba** ("donde diga API Gateway, interpretá Function
URL / `ApiUrl` / `techmoda-ai`") en lugar de reescribirlas: por eso siguen quedando ~40 menciones de
API Gateway, `/Prod`, `execute-api` y `techmoda-capstone` **en el cuerpo**. Al editar uno de esos
archivos, respetá el banner y no propagues las menciones viejas.

`VALIDATION_REPORT.md` es un informe fechado (oct-2025) de la variante anterior y **no tiene banner**:
describe 5 Lambdas con API Gateway y rutas de otra máquina. Tratalo como histórico, no como fuente.

`EPCC_EXPLORE.md` / `EPCC_PLAN.md` / `EPCC_COMMIT.md` son el registro del ciclo Explore-Plan-Code-Commit
de refactors pasados (migración de región, refactor de IAM). Están **excluidos a propósito** de los
greps de coherencia de `validate-all.sh`. No los actualices al cambiar código; escribí uno nuevo si
corrés otro ciclo EPCC.

## Convenciones

- **Contenido en español**, código e identificadores en inglés. Los `GUIA.md` usan una estructura fija:
  🎯 Objetivo · 🧩 Prerequisitos · 🧠 El concepto · 🚶 Paso a paso · 🔐 Mínimo privilegio ·
  ✅ Checklist de validación · 📝 Qué entra en el examen · 💸 Costo + 🧹 Cleanup. Respetala.
- **Cada sesión mapea a un dominio del AIF-C01** y lo dice explícitamente. La tabla sesión ↔ dominio
  está en `sessions/README.md` y en el `README.md`.
- **Nunca escribas la salida esperada de una llamada de IA sin haberla corrido.** Los `GUIA.md`
  reportan lo medido, no lo previsto; las estimaciones de costo van marcadas como *verificar contra
  precios oficiales*.
- **Explicá el porqué en el código.** Los headers de `app.py`, los snippets y los scripts llevan un
  bloque de comentario que dice qué servicio se usa, qué dominio del examen cubre y qué error evita.
  Ese comentario es material didáctico, no ruido: mantenelo al editar.
- **Preguntá antes de crear recursos en la nube** y decí después qué quedó creado. Leer y validar es
  gratis; desplegar stacks, subir objetos y crear guardrails cuesta.
