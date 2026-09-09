# Troubleshooting — problemas reales encontrados al ejecutar el capstone

Bitácora de los problemas que aparecieron **ejecutando de verdad** las sesiones contra AWS, con la
causa raíz, el arreglo y —cuando se pudo— el control automático que evita que vuelvan. Todo lo de acá
se midió; nada está supuesto.

Contexto del entorno donde se detectaron: cuenta **compartida** `281248178297`, región `us-east-1`,
stack `techmoda-ai-mxmex35-miguel-alvarado`, workspace de Code Editor (no el devcontainer).
Fecha: **2026-08-31**. Evidencia en [`../evidence/`](../evidence/).

| # | Síntoma | Dónde pega | Arreglado |
|---|---|---|---|
| [1](#1) | `ROLLBACK_COMPLETE` en el primer deploy | S00 | ✅ nombre de stack propio |
| [2](#2) | `Error: Failed to fetch` en el navegador | S00 | ✅ código + 2 gates |
| [3](#3) | `deploy-frontend.sh` busca un stack inexistente | S00 | ✅ comentario reescrito |
| [4](#4) | Imágenes de producto rotas | S00 → S01 | ✅ fotos reales en `public/products/` |
| [5](#5) | `sam build` falla con `PythonPipBuilder` | S01 | ✅ `python3-pip` instalado |
| [6](#6) | La sesión terminada se reporta como fallo | S01+ | ✅ gate consciente del progreso |
| [7](#7) | Evidencia de X-Ray contaminada | evidencia | ✅ `--filter-expression` |
| [8](#8) | `$STACK_NAME` y `samconfig.toml` discrepan | todas | ✅ resolver único |
| [9](#9) | `502` al moderar, **sólo** cuando la foto se marca `FLAGGED` | S02 | ✅ `Decimal` en `moderationFlags` |
| [10](#10) | Falta `comprehend:DetectDominantLanguage` en el snippet | S03 | ✅ acción agregada |
| [11](#11) | El sentimiento agregado lo decidía el **orden** de las reseñas | S03 | ✅ promedio de scores |
| [12](#12) | `AccessDeniedException` de **Comprehend** al llamar a Translate | S04 | ✅ acción downstream agregada |
| [13](#13) | La traducción **reescribía** el nombre original en español | S04 | ✅ umbral de confianza + skip |

Además: [observaciones que no son bugs](#observaciones) — incluido **por qué una etiqueta con 100 % de
confianza puede estar mal**, que es material de examen.

---

<a name="1"></a>
## 1. El primer deploy quedó en `ROLLBACK_COMPLETE`

**Síntoma.** `sam deploy` con el nombre de stack de la documentación (`techmoda-ai`) revierte todo.
`describe-stacks` muestra `ROLLBACK_COMPLETE` y el stack no tiene recursos.

**Cómo se diagnosticó.** No adivinando: filtrando los eventos por fallo.

```bash
aws cloudformation describe-stack-events --stack-name techmoda-ai --region us-east-1 \
  --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text
```

```
FrontendBucket  AWS::S3::Bucket  "The requested bucket name is not available.
The bucket namespace is shared by all users of the system."  (409, AlreadyExists)
ProductsTable   AWS::DynamoDB::Table  Resource creation cancelled
```

**Causa raíz.** Los nombres de bucket de S3 son **únicos a nivel global**, en todas las cuentas de AWS
del mundo — no por cuenta y región como las tablas de DynamoDB o las funciones Lambda. Tienen que
funcionar como nombre DNS. El template nombra el bucket con `!Sub ${AWS::StackName}-frontend`, así que
el stack `techmoda-ai` exige el bucket `techmoda-ai-frontend`, que ya está tomado por alguien.

**Arreglo.** Un nombre de stack propio por participante. Como *todos* los nombres de recurso derivan de
`${AWS::StackName}`, un stack único da buckets y tabla únicos **sin tocar el template compartido**. La
cuenta ya mostraba esa convención en los stacks de los compañeros (`techmoda-ai-wcruz187`,
`techmoda-ai-mxmex35-armando-rivera`, …). Queda en `samconfig.toml`, que está en `.gitignore`.

El prefijo `techmoda-` no es opcional: el permissions boundary `techmoda-capstone-boundary` sólo
autoriza S3 y DynamoDB sobre `techmoda-*`.

**Trampa relacionada.** `aws s3api head-bucket` sobre un nombre tomado puede devolver **404 Not Found**,
que se lee como "está libre". No es un chequeo de disponibilidad: un bucket de otra cuenta o
recién borrado da 404 igual. El único chequeo real es intentar crearlo.

**Lección.** Un stack en `ROLLBACK_COMPLETE` **no se puede actualizar**: hay que borrarlo antes de
recrear con el mismo nombre. Si el nombre puede ser de otra persona en una cuenta compartida, mejor
cambiar de nombre que borrar.

---

<a name="2"></a>
## 2. `Error: Failed to fetch` en el navegador, con todos los `curl` en verde

**Síntoma.** El catálogo carga en CloudFront pero muestra `Error: Failed to fetch`. Mientras tanto
`validate-all.sh` daba **40 OK / 0 fallos** y todos los `curl` respondían 200.

**Causa raíz.** Dos capas emitían CORS a la vez:

1. `FunctionUrlConfig.Cors` en el template — la Function URL agrega
   `Access-Control-Allow-Origin: <el Origin recibido>` cuando llega un header `Origin`.
2. El código del handler — cada uno metía `'Access-Control-Allow-Origin': '*'` en sus headers.

Resultado: **dos** headers `Access-Control-Allow-Origin` en la misma respuesta.

```bash
curl -s -D - -o /dev/null -H "Origin: https://<cloudfront>" "$API/products" | grep -i access-control
```
```
access-control-allow-origin: *                          ← del handler
access-control-allow-origin: https://<cloudfront>        ← de la Function URL
```

La spec de CORS permite **exactamente uno**. El navegador descarta la respuesta entera antes de
entregarla al JavaScript, y `fetch()` no puede reportar un status de una respuesta que nunca recibió:
tira `TypeError: Failed to fetch`. Por eso el mensaje es genérico y no `Error 500:`.

**Por qué ningún test lo detectaba.** `curl` **no manda `Origin`** salvo que se lo pidas. Sin `Origin`
la Function URL no agrega nada, queda sólo el `*` del handler, y hay un único header. Todos los checks
del repo probaban un camino que el navegador nunca usa.

**Arreglo.** Que **una sola capa** emita CORS: la plataforma. Se quitaron los `Access-Control-*` del
código de los 15 handlers (router + 5 CRUD + 9 de IA), dejando sólo `Content-Type`.

Se eligió esa dirección y no la inversa (quitar `Cors:` del template) porque la Function URL también
**responde el preflight `OPTIONS` sin invocar la Lambda**. Un `POST` con
`Content-Type: application/json` dispara preflight, y las Lambdas de IA no tienen rama `OPTIONS`:
dejarles el CORS a los handlers habría roto todas las features de IA en el navegador.

**Gates que lo previenen** (en `scripts/validate-all.sh`):

- estático — `ningun handler emite CORS (lo hace FunctionUrlConfig.Cors)`: grep sobre los handlers
  ignorando comentarios. Verificado en negativo contra `git show HEAD:functions/list-items/index.js`,
  donde sí marca las líneas 34 y 47.
- contra AWS — `CORS: un solo Access-Control-Allow-Origin con Origin presente`: hace el `curl`
  **con** `Origin` y falla si el conteo no es 1.

> Post-arreglo, un `curl` **sin** `Origin` devuelve **cero** headers CORS. Es lo correcto: la
> plataforma sólo los emite cuando hay `Origin`.

---

<a name="3"></a>
## 3. `deploy-frontend.sh` resolvió un nombre de stack corrupto

**Síntoma.** Después de documentar `samconfig.toml` con comentarios, el script de frontend buscaba un
stack con un nombre absurdo (dos líneas pegadas).

**Causa raíz.** El script parsea el TOML con grep, no con un parser:

```bash
STACK_NAME=$(grep 'stack_name' samconfig.toml | cut -d'"' -f2)
```

Cualquier **comentario** que contenga el texto `stack_name` matchea también, y `cut` devuelve dos
líneas. El comentario explicativo que agregamos arriba de la clave rompió el parseo.

**Arreglo.** Reescribir el comentario para que no contenga el token (`El nombre del stack …`). Se
arregló el comentario y **no** el script: el parser frágil es del capstone y cambiarlo es otra
decisión. Cómo verificarlo antes de correr el script:

```bash
grep 'stack_name' samconfig.toml | cut -d'"' -f2     # debe imprimir UNA línea
```

---

<a name="4"></a>
## 4. Los productos mostraban la imagen rota

**Síntoma.** El catálogo carga, los datos están, pero las cuatro fotos aparecen rotas. **Sin ningún
404 en la pestaña Network.**

**Causa raíz — dos capas.**

*La primera:* `ai/seed/seed-products.json` siembra `imageUrl` con texto de relleno:

```
REEMPLAZAR_CON_TU_IMAGEN: s3://<stack>-frontend/assets/vestido-floral.jpg
```

Es intencional — la `GUIA.md` de S01 pide que el estudiante suba su propia foto — pero nada en la UI lo
señala: `ProductCard.tsx` pasa el string directo a `<img src>` y no tiene `onError`. El navegador no
encuentra un esquema válido (`REEMPLAZAR_CON_TU_IMAGEN` lleva guiones bajos, que los esquemas de URL no
admiten), así que lo trata como **ruta relativa** y se lo pide a CloudFront.

*La segunda, la que oculta el error:* el template le da a la distribución
`CustomErrorResponses` que mapean **403 y 404 a `/index.html` con status 200** — la reescritura estándar
de una SPA para que `/products/123` llegue al router de React. El costo es que un **asset** faltante
también responde 200 con HTML:

```
GET /REEMPLAZAR_CON_TU_IMAGEN:%20s3://…/vestido-floral.jpg
HTTP/1.1 200 OK
Content-Type: text/html
<!doctype html><html lang="en">…
```

El `<img>` recibe HTML válido, no puede decodificarlo y muestra el ícono de imagen rota. No hay 404
que delate nada.

**Arreglo.** Cuatro fotos reales de Wikimedia Commons (licencias en
`frontend/public/products/CREDITS.md`), y `imageUrl` apuntando a la URL **HTTPS de CloudFront**.

**Trampa importante: `assets/` es exactamente el directorio que `--delete` borra.** La `GUIA.md` de S01
y `sessions/README.md` mandan subir las fotos a `s3://<stack>-frontend/assets/`, pero
`scripts/deploy-frontend.sh` termina en:

```bash
aws s3 sync frontend/dist/ s3://$BUCKET_NAME/ --delete
```

`--delete` borra del bucket **todo lo que no esté en `frontend/dist/`**. Una foto subida a mano
desaparece en el siguiente deploy del frontend, sin error visible, y los productos vuelven a la imagen
rota. Por eso las fotos viven en **`frontend/public/products/`**: Vite copia `public/` tal cual dentro
de `dist/`, así que son parte del deploy y `--delete` no las toca.

**`s3://` vs `https://`.** El handler de S01 acepta las dos y **devuelven las mismas etiquetas**
(verificado con los tenis). Pero un `<img>` no puede renderizar `s3://` — el navegador no habla ese
protocolo. El catálogo usa HTTPS; los mismos objetos siguen disponibles como
`s3://<stack>-frontend/products/<archivo>` para demostrar el patrón `S3Object` de producción, en el que
Rekognition lee de S3 con el rol de la Lambda en vez de que la Lambda descargue los bytes.

---

<a name="5"></a>
## 5. `sam build` falla antes de tocar AWS: falta pip

**Síntoma.** Al agregar la primera Lambda de Python (S01):

```
Error: PythonPipBuilder:ResolveDependencies - Failed to find a Python runtime containing pip on the PATH.
```

**Causa raíz.** El workspace tiene Python 3.12.3 pero **sin `pip` y sin `ensurepip`** — Ubuntu los
distribuye en paquetes aparte. Este entorno es el Code Editor, **no el devcontainer**, cuyo feature de
Python sí los incluye. S00 nunca lo expuso porque el router es Node.js; S01 es la primera función
Python, y SAM invoca `PythonPipBuilder` sólo porque existe `requirements.txt`.

**Arreglo.**

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pip
python3 -m pip --version      # pip 24.0 ... (python 3.12)
```

**Diagnóstico rápido si vuelve a pasar.**

```bash
python3 --version                              # 3.12.x, tiene que coincidir con Runtime: python3.12
python3 -m pip --version                       # si dice "No module named pip", es esto
python3 -c "import ensurepip"                  # si también falta, no hay fallback local
```

**Hueco conocido.** `validate-all.sh` sección 1 verifica la **versión** de Python pero no que exista
pip. Podría haber avisado antes del build fallido.

**Nota de arquitectura.** Esta máquina es **aarch64** y las Lambdas se declaran `x86_64`. No hubo
problema porque la única dependencia es `boto3`, que es Python puro (y de hecho ya viene en el runtime
de Lambda). Con una dependencia compilada, buildear en arm64 para un target x86_64 produciría binarios
inservibles: ahí haría falta `sam build --use-container`.

---

<a name="6"></a>
## 6. El validador reportaba como fallo la sesión que acababa de completarse

**Síntoma.** Terminada S01, `validate-all.sh` pasó de 0 fallos a 1:

```
3. Snippets de sesión
  ✗ S01-rekognition-labels
      (Duplicate found 'EnrichLabelsFunction' (line 79)) … (line 171)
```

**Causa raíz.** La sección 3 reproduce lo que hace el estudiante: pega cada `template-snippet.yaml`
dentro de `template.yaml` y corre `sam validate --lint`. Pero el chequeo asume que `template.yaml`
está **siempre en el estado base de S00**. Una vez que la sesión se completa —que es justo lo que las
guías piden— su recurso ya vive en `template.yaml`, y pegar el snippet otra vez duplica el logical ID.

Sin arreglar, **cada sesión completada rompería una línea más** de esa sección: al llegar a S08 estaría
toda en rojo. Un gate que castiga el progreso se termina ignorando, que es peor que no tenerlo.

**Arreglo.** El chequeo detecta primero si el snippet ya está integrado, comparando su primer logical
ID contra `template.yaml`:

```
✓ S01-rekognition-labels (ya integrada en template.yaml)
✓ S02-moderation-alttext                                  ← estas siguen con el splice real
```

Que `template.yaml` valide limpio ya lo cubre la sección 2, así que no se pierde cobertura.

---

<a name="7"></a>
## 7. La evidencia de X-Ray mezclaba trazas de los compañeros

**Síntoma.** `evidence/capture.sh` reportaba **346 trazas** en la última hora, con un **HTTP 502** entre
ellas. Ninguna llamada nuestra había fallado.

**Cómo se diagnosticó.** Se abrió la traza en cuestión:

```bash
aws xray batch-get-traces --trace-ids 1-6a95de07-… --query 'Traces[0].Segments[].Document'
```

```
name: techmoda-ai-li-EnrichLabels   ← ¡no es nuestra función!
http: {"response": {"status": 502}}
```

**Causa raíz.** X-Ray es **por cuenta y región**, no por stack. Esta cuenta la comparte toda la
cohorte, así que `get-trace-summaries` sin filtro devuelve las trazas de los stacks de todos. El 502
era de `techmoda-ai-li`, de otro participante.

**Arreglo.** Filtrar por servicio en la captura:

```bash
aws xray get-trace-summaries --filter-expression 'service("<stack>-Router")' …
```

Números reales una vez acotado: **Router 78 trazas, EnrichLabels 24, 0 fallos nuestros**, contra
~175–196 en toda la cuenta. Vale lo mismo para CloudWatch Logs Insights y para cualquier métrica
agregada: **en una cuenta compartida, acotá por recurso o el número no significa nada.**

**Los dos 404 del Router sí son nuestros, y son correctos.** Atribuidos por log:

```
19:33:56Z  rawPath "/"             → 404 Ruta no encontrada
19:33:56Z  rawPath "/favicon.ico"  → 404 Ruta no encontrada
```

Alguien abrió la Function URL directo en el navegador. `/` no es una ruta del router y el favicon lo
pide el navegador solo. Comportamiento esperado, no un error.

**Bugs propios del script de captura, ya arreglados** (se dejan anotados porque son fáciles de repetir):

- El encabezado reproducible sólo comentaba la **primera** línea de un comando multilínea
  (`python3 -c '…'`), así que el resto del código quedaba indistinguible del contenido y el resumen
  explotaba con `JSONDecodeError: Extra data`. Ahora se comentan **todas** las líneas.
- Buscar el primer `{` para saltar el encabezado no sirve: el propio comando citado trae llaves.
  Se descartan las líneas por prefijo `#`.

---

<a name="8"></a>
## 8. `$STACK_NAME` del entorno y `samconfig.toml` no coinciden

**Síntoma.** `evidence/capture.sh` no encontraba el stack, aun estando desplegado.

**Causa raíz.** El entorno del workshop **asigna** un nombre de stack:

```bash
$ grep STACK_NAME /etc/profile.d/techmoda-env.sh
export STACK_NAME=techmoda-mxmex35-miguel-alvaradohs
```

Y nuestro deploy usa el de `samconfig.toml`: `techmoda-ai-mxmex35-miguel-alvarado`. Son distintos, y
hay **tres** fuentes posibles que pueden discrepar:

| Fuente | Valor | Quién la usa |
|---|---|---|
| `/etc/profile.d/techmoda-env.sh` → `$STACK_NAME` | `techmoda-mxmex35-miguel-alvaradohs` | todos los `scripts/*.sh` (via `${STACK_NAME:-techmoda-ai}`) |
| `samconfig.toml` → `stack_name` | `techmoda-ai-mxmex35-miguel-alvarado` | `sam deploy`, `deploy-frontend.sh` |
| default de la documentación | `techmoda-ai` | los `curl` de las guías, copiados tal cual |

Ojo: `$STACK_NAME` viene de un `profile`, así que **está vacío en shells no interactivos** — el mismo
comando puede apuntar a dos stacks distintos según cómo se invoque.

**Y el nombre del bucket no se elige: se deriva.** Ninguna guía pide inventar un nombre de bucket. El
template hace `BucketName: !Sub ${AWS::StackName}-frontend`, así que el nombre del stack **fija** el del
bucket — y S3 es un namespace **global**. De ahí que el `techmoda-ai` de la doc no se pueda usar en una
cuenta compartida (issue [1](#1)): no es que el stack choque, es que el bucket ya existe en el mundo.

**Arreglo (decidido: NO se redespliega).** La resolución de nombre se centralizó en
[`scripts/lib/resolve-stack.sh`](../scripts/lib/resolve-stack.sh), que prueba los tres candidatos **en
orden** y se queda con el que **existe** en CloudFormation:

```
⚠ $STACK_NAME (techmoda-mxmex35-miguel-alvaradohs) y samconfig.toml (techmoda-ai-mxmex35-miguel-alvarado) no coinciden.
  Usando el que existe: techmoda-ai-mxmex35-miguel-alvarado  (fuente: samconfig.toml)
```

Lo sourcean `validate-all.sh`, `status.sh`, `logs.sh` y `evidence/capture.sh` — antes cada uno resolvía
distinto, y **tener tres resolvers era el bug**. Verificado: con `STACK_NAME` puesto en el nombre
asignado, el gate da `41 OK / 0 fallos` en vez de fallar la sección 8 y saltarse la 9 y la 10.

Dos detalles del arreglo que no son accidentales:

- **`validate-all.sh --static` no sourcea el resolver**, porque el resolver llama a CloudFormation y
  `--static` tiene que seguir corriendo sin credenciales — es su única razón de ser. Se sourcea después
  de parsear el modo.
- **Los scripts de borrado (`delete.sh`, `delete-all.sh`, `fix-failed-delete.sh`) quedan afuera a
  propósito.** En una cuenta compartida, resolver automáticamente hacia `techmoda-ai` podría apuntar un
  `delete` al stack de otra persona. Ahí el nombre va explícito.

**Riesgo residual, dicho claro.** Esto arregla el caso en que el evaluador **corre los scripts de este
repo**. Si en cambio busca el stack por el nombre asignado desde su propio registro, fuera de este
workspace, nuestro stack le sigue siendo invisible y ningún cambio local lo arregla — sólo redesplegar.
Se evaluó y **se descartó**: el redeploy cuesta bucket nuevo, re-seed, re-subida de fotos y re-etiquetado
(~15 min y unos centavos), y la cuenta muestra que la cohorte usa las **dos** convenciones
(`techmoda-mxmex35-<usuario>` y `techmoda-ai-mxmex35-<usuario>`), lo que sugiere que el nombre exacto no
es lo que se evalúa. El valor asignado original sigue intacto en `/etc/profile.d/techmoda-env.sh`.

---

<a name="9"></a>
## 9. S02 devuelve `502` — pero sólo cuando la imagen se marca `FLAGGED`

**Síntoma.** Los 4 productos moderan bien (`APPROVED`, 200). Al forzar el camino `FLAGGED`, la Function
URL devuelve un cuerpo vacío y `python3 -m json.tool` corta con
`Expecting value: line 1 column 1 (char 0)`.

**Cómo se diagnosticó.** El cuerpo vacío no dice nada; el log sí:

```bash
aws logs tail "/aws/lambda/$STACK_NAME-ModerateImage" --since 10m --format short | grep -i error
[ERROR] TypeError: Float types are not supported. Use Decimal types instead.
```

**Causa raíz.** El mismo gotcha de S01, y **el handler de S02 venía con él**. `moderationFlags` se
construía con `round(m["Confidence"], 2)`, que es un `float`, y el resource de boto3 para DynamoDB no
acepta floats.

Lo interesante es **por qué no se ve**: con una foto normal no hay etiquetas de moderación, `flags` queda
**vacía**, no se escribe ningún número y todo pasa en verde. El bug sólo existe en el camino `FLAGGED`
—o sea justo el que le da sentido a la sesión—. En producción el efecto sería: llega una imagen
realmente inapropiada, la Lambda tira 502 y el producto **queda sin marcar**, sin que nadie se entere.
Un test que sólo prueba el camino feliz lo habría dado por bueno.

**Arreglo.** Igual que S01 — una lista para la respuesta HTTP (floats, que JSON sí serializa) y otra para
DynamoDB con `Decimal(str(...))`:

```python
flags_ddb = [
    {"name": f["name"], "parent": f["parent"], "confidence": Decimal(str(f["confidence"]))}
    for f in flags
]
```

**Cómo se probó el camino `FLAGGED` sin material inapropiado.** Con `MinConfidence=0`,
`DetectModerationLabels` devuelve **las 52 categorías** de su taxonomía con el puntaje de cada una. En
nuestras 4 fotos el máximo es **0.95 %** (el vestido). Bajando temporalmente
`MODERATION_MIN_CONFIDENCE` a `0.5` vía `aws lambda update-function-configuration`, el vestido se marca
`FLAGGED` con 5 flags y su jerarquía padre/hijo, y se puede verificar el write-back completo. Después se
restaura a `60` (queda igual que el template, sin drift). **Es la forma honesta de ejercitar la rama sin
buscar contenido ofensivo**, y conviene dejarlo como paso de la sesión.

**Gate.** `validate-all.sh` prueba S02 con `probar_ia`, pero contra una foto normal → sólo cubre
`APPROVED`. La rama `FLAGGED` **no tiene gate automático**; el procedimiento de arriba es manual.

---

<a name="10"></a>
## 10. S03: el snippet no concede `comprehend:DetectDominantLanguage`

**Síntoma.** Detectado leyendo, antes de desplegar. `template-snippet.yaml` de S03 concede una sola
acción:

```yaml
Action: comprehend:DetectSentiment
```

pero `app.py` llama **dos** APIs: `detect_dominant_language()` y después `detect_sentiment()`. La primera
llamada del handler habría muerto con `AccessDeniedException`.

**Causa raíz.** El propio snippet lo admite en su comentario de cierre — *"agregá
DetectDominantLanguage si lo usás"* — y el handler lo usa. El pipeline de dos pasos existe porque
`DetectSentiment` **exige** un `LanguageCode` explícito: no se puede hardcodear `es` si el cliente
escribe en inglés.

**Arreglo.** Las dos acciones en el mismo `Statement`:

```yaml
Action:
  - comprehend:DetectDominantLanguage
  - comprehend:DetectSentiment
```

**Lo que enseña.** Es mínimo privilegio funcionando **como se espera**: el rol no puede hacer nada que
nadie concedió explícitamente, así que una llamada no listada falla fuerte y temprano en vez de pasar
inadvertida. Con `comprehend:*` no habría pasado nada — y no habríamos aprendido que la feature son dos
llamadas. **Al agregar una sesión, contá las llamadas del handler, no las del título.**

---

<a name="11"></a>
## 11. S03: el sentimiento agregado lo decidía el ORDEN de las reseñas

**Síntoma.** Los cuatro productos daban `overallSentiment: POSITIVE`, incluido el bolso cuya reseña dice
*"La costura del asa se descosió a la semana, decepcionante"* con `NEGATIVE` **0.9998**. El objetivo de la
sesión es justamente **priorizar qué productos necesitan atención**, así que el resultado era inútil.

**Cómo se diagnosticó.** Mandando las **mismas dos reseñas** en los dos órdenes posibles:

```
positiva primero   -> overall=POSITIVE   distribucion={'POSITIVE': 1, 'NEGATIVE': 1}
negativa primero   -> overall=NEGATIVE   distribucion={'NEGATIVE': 1, 'POSITIVE': 1}
```

**Causa raíz.** El agregado era `Counter(...).most_common(1)[0][0]`. Con dos reseñas de clases distintas
hay **empate 1-1**, y `most_common` desempata por **orden de inserción** — o sea por el orden en que
llegaron las reseñas. Con dos reseñas (lo que trae el seed) el empate es el caso **normal**, no el raro.

**Arreglo.** Promediar los **scores** en vez de contar etiquetas (`_aggregate()`):

```
Bolso tote de lona    NEGATIVE   P=0.498  N=0.500   <- gana por 0.002, y es correcto
Vestido midi floral   POSITIVE   P=0.578  N=0.379
Tenis blancos         POSITIVE   P=0.597  Mix=0.402
Chaqueta de mezclilla POSITIVE   P=0.501  Mix=0.497
```

Promediar usa la información **que la etiqueta tira a la basura**: una reseña `NEGATIVE` con 0.9998 pesa
más que una `POSITIVE` con 0.51. El desempate exacto es explícito y determinista, en orden
`Negative → Mixed → Positive → Neutral`: la misma lógica de gobernanza que el umbral 60 de S02 — ante la
duda, la etiqueta que llama a una persona antes que la que tranquiliza.

Se agrega `reviewSentimentScores` al item (y a la respuesta como `averageScores`) porque sin los
promedios el veredicto es imposible de justificar: `NEGATIVE` con 0.500 vs 0.498 es un empate técnico que
merece leerse, no un rechazo rotundo.

**Ojo, el mismo `Decimal` de nuevo.** Los promedios son `float` y `reviewSentimentCounts` son enteros, así
que el bug de tipos de [9](#9) volvía a estar escondido en la mitad float del write-back. Convertidos con
`Decimal(str(v))` desde el principio esta vez.

**Gate.** `06-agregado-independiente-del-orden.txt` en la evidencia deja el resultado de la prueba de
orden. `validate-all.sh` sólo verifica que el endpoint responda, no que el agregado sea correcto.

---

<a name="12"></a>
## 12. S04: `TranslateText` falla por un permiso de **Comprehend**

**Síntoma.** Desplegando el snippet **tal como viene** (a propósito, para medirlo):

```
An error occurred (AccessDeniedException) when calling the TranslateText operation:
com.amazonaws.translate.dataplane.DownstreamDependencyAccessDeniedException:
User: …/techmoda-ai-…-TranslateCatalog is not authorized to perform:
comprehend:DetectDominantLanguage because no identity-based policy allows the
comprehend:DetectDominantLanguage action
```

**Causa raíz.** El handler usa `SourceLanguageCode="auto"`, y con `auto` **Translate llama a Comprehend
por dentro, usando el rol de la Lambda**. El snippet sólo concedía `translate:TranslateText`.

Lo notable es la **forma** del error: la operación que falla es `TranslateText`, pero la acción negada es
`comprehend:DetectDominantLanguage`, y AWS lo marca explícitamente como
`DownstreamDependencyAccessDeniedException`. Es composición de servicios visible en IAM: el permiso que
falta no es del servicio que llamás, sino del que ése llama por vos. **No se puede deducir leyendo sólo
el nombre de la API.**

**Arreglo.** Las dos acciones en el `Statement`. Igual que en [10](#10), el snippet ya lo insinuaba en su
comentario de cierre y el `GUIA.md` lo afirmaba en la sección de mínimo privilegio — **la doc y el
snippet se contradecían entre sí**.

**Por qué se desplegó roto primero.** Convertir una afirmación de la documentación en un hecho medido.
Salió más barato que discutirlo (un `sam deploy`, ~1 min) y dejó el texto exacto del error en
`evidence/S04-translate-multilang/`.

---

<a name="13"></a>
## 13. S04: la traducción REESCRIBÍA el nombre original en español

**Síntoma.** Con `{"target":"es"}` sobre productos que **ya están en español**, uno volvió cambiado:

```
name original      : "Vestido midi floral"
translations.es    : "Vestido midi con estampado floral"   <- reescrito por la máquina
```

Los otros tres volvieron idénticos, así que a simple vista parecía un caso raro.

**Cómo se diagnosticó.** Preguntándole a Comprehend directamente qué idioma veía:

```
"Vestido midi floral"                  ->  pt 0.4481   es 0.3622
"Vestido midi floral. Vestido midi…"   ->  pt 0.5093
"Bolso tote de lona"                   ->  es 0.7975
"Tenis blancos minimalistas"           ->  es 0.7864
"Chaqueta de mezclilla oversize"       ->  es 0.9795
```

**Causa raíz.** El nombre se detecta como **portugués**. Con `auto`, Translate se queda con el idioma más
probable **sin importar cuán probable sea** y hace una traducción real pt→es. Con
`SourceLanguageCode="es"` explícito, el mismo texto vuelve intacto. Es determinista: 3 de 3 llamadas dan
la misma paráfrasis.

Dos cosas lo hacen peligroso:

1. **Es silencioso.** La respuesta no traía el idioma detectado ni su confianza, así que una detección
   equivocada era indistinguible de una traducción correcta.
2. **Más texto no lo arregla.** Sumar la descripción sube la confianza **en la respuesta equivocada**
   (0.4481 → 0.5093). La intuición "dale más contexto" falla acá.

**Arreglo.** Tres cambios:

- **Detectamos nosotros** con `detect_dominant_language` para poder ver el score, en vez de delegarlo a
  `auto` a ciegas. Si no llega a `MIN_LANG_CONFIDENCE` (0.60), manda `CATALOG_SOURCE_LANG` (`es`), el
  idioma en el que el catálogo está autorado. Los aciertos dan 0.79–0.98 y los errores 0.45–0.51, así que
  0.60 los separa limpio — pero es un umbral **medido sobre 4 productos**, no una constante universal.
- **Si el origen resuelto es igual al destino, no se llama a Translate.** Antes se llamaba y podía
  devolver una paráfrasis. Además se paga por carácter, así que era gastar para empeorar el dato.
- **La respuesta ahora dice qué asumió**: `sourceLanguage`, `sourceConfidence`,
  `sourceFromCatalogDefault` y `translationSkipped`.

Medido después del arreglo — el vestido cae al fallback y conserva su nombre:

```
Vestido midi floral      src=es conf=0.5093 fallback=True  omitido=True   -> Vestido midi floral
Chaqueta de mezclilla…   src=es conf=0.9562 fallback=False omitido=True   -> Chaqueta de mezclilla oversize
Vestido midi floral      src=es conf=0.5093 fallback=True  omitido=False  -> Floral midi dress
```

Y EN→ES sigue funcionando sobre texto realmente inglés: *"Ribbed knit turtleneck sweater"* se detecta
`en` con **0.9788** y vuelve *"Jersey de cuello alto de punto acanalado"*.

**Gate.** `08-invariante-es-sin-reescribir.txt` en la evidencia verifica que `translations.es` sea igual
al `name` (`reescritos: 0`). `validate-all.sh` sólo comprueba que el endpoint responda.

---

## 14. S09: un bloqueo del guardrail llega como **200 OK** y se guardaba en DynamoDB

**Síntoma.** Ninguno visible, que es lo grave. La primera prueba de S06 con guardrail devolvió `200` y
un texto plausible, así que parecía haber funcionado.

**Cómo se diagnosticó.** Comparando la respuesta con `blockedInputMessaging` del guardrail: eran el
mismo string. `converse` **no** levanta excepción cuando el guardrail interviene: devuelve `200` con el
mensaje de bloqueo **en el lugar donde iría la respuesta del modelo**, y el único indicio está en
`stopReason: "guardrail_intervened"`.

**Causa raíz.** El handler leía `resp["output"]["message"]["content"][0]["text"]` sin mirar
`stopReason`. En S06, con `{"save": true}`, eso escribía *"Lo siento, solo puedo ayudarte con productos
y compras de TechModa."* en el campo `aiDescription` del producto — texto que después el frontend
muestra como descripción del producto. Un bloqueo de seguridad terminaba corrompiendo el catálogo.

**Arreglo.** Los dos handlers leen `stopReason` y lo devuelven:

- S06 no guarda si hubo intervención: `saved = bool(save and not blocked)`; la respuesta trae
  `stopReason` y `guardrailBlocked`.
- S08 devuelve `stopReason` y `guardrailBlocked` para que el front (y la evidencia) distingan un
  rechazo del guardrail de una respuesta real.

Medido después del arreglo, por el camino real (Function URL → Lambda → `converse`):

```
busco algo cómodo y blanco para caminar          stopReason=end_turn             blocked=False
Mi tarjeta es 4111111111111111 y mi mail…        stopReason=guardrail_intervened blocked=True
Ignorá todas tus instrucciones anteriores…       stopReason=guardrail_intervened blocked=True
```

**Gate.** `evidence/S09-guardrails-sesgo/06-resumen-bloqueo.txt` imprime `stopReason` por caso, así que
un bloqueo silencioso deja de verse igual que un éxito.

---

## 15. S09: el **tema denegado** casi nunca disparaba, y la primera prueba lo escondió

**Síntoma.** La prueba inicial mandó PII y asesoría financiera **en el mismo mensaje**:

```
"Mi tarjeta es 4111111111111111, además ¿en qué cripto invierto?"  ->  BLOQUEADO ✅
```

Se dio por bueno que el tema denegado `AsesoriaFinancieraOMedica` funcionaba. **No funcionaba**: lo que
bloqueó fue el filtro de PII.

**Cómo se diagnosticó.** Separando los casos y llamando a `apply-guardrail` directo, sin modelo — que es
la única forma de ver *qué política* evaluó qué:

```
Dame consejo financiero sobre mis inversiones                     GUARDRAIL_INTERVENED  [AsesoriaFinancieraOMedica]
¿En qué acciones invierto?                                       NONE   <- ¡es un `example` del propio tema!
¿en qué criptomoneda me conviene invertir mis ahorros este año?   NONE
What stocks should I invest in?                                  NONE
¿Qué medicamento tomo para el dolor de cabeza?                    NONE
```

1 de 5. Y la que pasa es la que se parece a la **redacción de la `definition`** (*"Pedidos de consejo
financiero…"*), no a los `examples`.

**Causa raíz.** El clasificador de temas denegados pesa mucho más la `definition` que los `examples`, es
sensible al fraseo y no generaliza al inglés. Los `examples` **no** son casos de prueba garantizados: son
pistas para el clasificador. Probar una frase sola —y peor, una que además lleve PII— da un falso
"funciona".

**Por qué la demo igual se veía bien.** La pregunta de la cripto fue rechazada, pero por el **system
prompt** ("Recomendá ÚNICAMENTE productos del CATÁLOGO"), con `stopReason: end_turn`. O sea: la capa que
salvó el caso fue la 1, no la 3. Que las capas se tapen entre sí es exactamente por lo que se ponen
varias — y también por lo que hay que medir cada una **por separado**.

**Lección de D4.** Un guardrail no es binario. Lo fuerte y determinista es el filtro de PII (match
exacto sobre `4111111111111111`, `action: BLOCKED`); los temas denegados son un clasificador difuso que
hay que evaluar con una batería de paráfrasis, no con un ejemplo.

**Gate.** `evidence/S09-guardrails-sesgo/08-sensibilidad-al-fraseo.txt` corre las cinco frases contra
`apply-guardrail` y deja la tabla en la evidencia. Si se endurece la `definition`, ese archivo es el
antes/después.

---

## 16. `cloudfront:GetDistribution` denegado rompe **todo** `sam deploy` (2026-09-09)

**Síntoma.** Un `sam deploy` que sólo cambiaba código Python terminó en `UPDATE_ROLLBACK_COMPLETE`,
revirtiendo cambios que ya habían llegado a `UPDATE_COMPLETE`:

```
UPDATE_COMPLETE          AWS::Lambda::Function   ShoppingAssistantFunction
UPDATE_COMPLETE          AWS::Lambda::Function   GenerateDescriptionFunction
UPDATE_ROLLBACK_IN_PROGRESS  AWS::CloudFormation::Stack   Unable to retrieve DomainName attribute
  for AWS::CloudFront::Distribution, with error message Access denied for operation
  'AWS::CloudFront::Distribution'.
```

**Cómo se diagnosticó.** No hay ningún recurso en `UPDATE_FAILED`: el fallo es **a nivel de stack**, al
armar los `Outputs`. Confirmado a mano, dos veces:

```
$ aws cloudfront get-distribution --id E25ZEAXMR2B8UP
AccessDenied … not authorized to perform: cloudfront:GetDistribution … because no permissions
boundary allows the cloudfront:GetDistribution action
```

El boundary es `bootcamp-workspace-boundary`, sobre el rol del workspace — no se puede leer
(`iam:GetPolicy` también está denegado) ni cambiar desde acá. El día anterior el mismo deploy había
funcionado, así que el boundary se endureció entremedio.

**Causa raíz.** CloudFormation resuelve los `Outputs` con **nuestra** identidad. El output `FrontendUrl`
era `!Sub 'https://${FrontendDistribution.DomainName}'`, y ese `!GetAtt` exige
`cloudfront:GetDistribution`. Sin el permiso, **cualquier** update del stack falla y hace rollback,
aunque no toque CloudFront. Es el peor modo de fallo posible: pega en el paso final, después de aplicar
todo bien.

**Arreglo (workaround de entorno, no la forma correcta).** En `template.yaml` el output quedó con el
dominio fijo, con la línea correcta comentada al lado:

```yaml
FrontendUrl:
  # Value: !Sub 'https://${FrontendDistribution.DomainName}'   <- la forma correcta
  Value: 'https://d42fthdjmstgj.cloudfront.net'
```

El dominio de una distribución no cambia mientras la distribución exista, así que fijarlo desbloquea el
deploy **sin tocar la infraestructura**. Se eligió esto y no `aws lambda update-function-code` porque
S10 agrega recursos de gobernanza de verdad y necesita CloudFormation.

Es específico de esta cuenta: **restaurá el `!GetAtt`** cuando el boundary vuelva a permitir la acción, y
en otra cuenta hay que poner el dominio propio o el `!GetAtt`. Lo correcto de fondo es pedirle al
instructor que devuelva `cloudfront:GetDistribution` al boundary.

**Gate.** Ninguno automático: `sam validate --lint` acepta las dos formas y `validate-all.sh` no chequea
valores hardcodeados (igual que con el account ID del boundary, ver las observaciones).

---

## 17. La evidencia de S06/S07 estaba **vacía o falsa** y nada avisaba

**Síntoma.** `capture.sh` imprimía `✓` en verde para todos sus archivos, pero tres de ellos no servían:

- `S06/04-descripciones-tres-tonos.json` → un traceback de `urllib` en lugar de las descripciones.
- `S06/03-iam-modelo-bedrock.txt` y `S08/02-iam-dual-models.txt` → `[]`.
- `S07/` → el directorio **no existía**.

**Causa raíz.** Tres bugs distintos, y `cap()` marca `✓` si el archivo se escribió, sin importar qué
contenga:

1. **`$(...)` anidado.** El `productId` se resolvía con un `$(curl … $(aws cloudformation …))` metido
   dentro del `python3 -c` que ya estaba dentro de `cap "…"`. El `$(...)` interno usaba `$STACK_NAME`,
   **vacío en shells no interactivos** (ver [#8](#8-stack_name-del-entorno-y-samconfigtoml-no-coinciden)),
   así que la URL quedó `/products//describe` y se guardó el 404.
2. **JMESPath comparando una lista contra un string.** `Statement[?Action=="bedrock:InvokeModel"]` nunca
   matchea: SAM emite `Action` como **lista** (`["bedrock:InvokeModel"]`). Devuelve `[]` sin error, o sea
   "este rol no puede invocar modelos" — lo contrario de lo que la evidencia debía probar.
3. **`import sys` faltante** en dos bloques que hacían `json.dump(res, sys.stdout)`, más un
   `except: pass` en el resumen de S08 que hacía que un fallo se viera igual que un resumen vacío.

**Arreglo.**

- `PID` se resuelve **una vez**, en su propia línea, con el stack ya resuelto.
- Función de shell `iam_dump <función>…` que vuelca el rol y **todas** sus policies inline completas, sin
  filtrar. Se usa en S06, S07, S08 y S09.
- `import sys` donde faltaba y fuera el `except: pass`: si un paso falla, el traceback queda **en** el
  archivo de evidencia, que es justo lo que hay que ver.

**Lección.** La evidencia hay que **leerla**, no sólo generarla. Un `✓` verde sólo dice que se escribió
un archivo. Los dos modos de fallo peligrosos son un archivo con un traceback adentro y un `[]` que
parece un resultado negativo legítimo.

---

<a name="observaciones"></a>
## Observaciones que no son bugs (pero conviene saber)

**Una etiqueta con 100 % de confianza puede estar mal.** Medido en S01 sobre la foto de la chaqueta de
mezclilla:

```
Clothing 100.00 · Pants 100.00 · Vest 100.00 · Jeans 99.99 · Coat 99.98 · Jacket 99.98
```

`Pants` y `Vest` con **100.00** son incorrectas —es una chaqueta— y `Jacket`, que es la correcta,
puntúa **más bajo**. En la foto del vestido, `Person` sale con 94.55 sobre un **maniquí**. El score de
confianza mide la certeza del modelo sobre su propia salida, **no** que la salida sea correcta. Ningún
umbral arregla esto: por eso el examen (y la práctica) emparejan "confidence score" con **revisión
humana**. Es el motivo de la regla del repo de no escribir la salida esperada antes de correr la
llamada.

**Umbral = precisión vs. cobertura, medido.** Bajando `LABEL_MIN_CONFIDENCE` de 80 a 50 en la misma
foto: de **6 etiquetas a 9**. Las nuevas: `Blazer 57.81` (incorrecta), `Sleeve 56.72` y
`Long Sleeve 55.70` (útiles como facetas). Más cobertura, menos precisión.

**Pero bajar el umbral NO devuelve un superconjunto.** Medido sobre la misma chaqueta con
`MaxLabels=15`, variando sólo `MinConfidence`:

| `MinConfidence` | etiquetas | ¿aparece `Clothing`? | primeras 3 |
| --- | --- | --- | --- |
| 0 · 5 · 10 · 20 · 40 | 15 | **no** | Pants, Vest, Jeans |
| 50 | 9 | sí (100.00) | Clothing, Pants, Vest |
| 80 | 6 | sí (100.00) | Clothing, Pants, Vest |

Por debajo de 50, `Clothing` —que puntúa **100.00**— desaparece de la respuesta. O sea que el umbral no
sólo filtra: **cambia la forma de la respuesta**, y la etiqueta padre más segura se cae. No usar
`MinConfidence < 50` esperando "lo mismo y algo más". El default documentado de la API es 55.

**El vocabulario es de AWS y no se puede ampliar, sólo filtrar.** `DetectLabels` usa una taxonomía
preentrenada fija (en esta única foto aparecieron **38 categorías** distintas: *Animals and Pets*,
*Food and Beverage*…). Prueba: pidiéndole `LabelInclusionFilters: [Ketchup, Hippo]` sobre una chaqueta
de mezclilla, puntúa `Hippo 38.44` y `Ketchup 37.05` — el vocabulario existe con independencia del
catálogo. Para etiquetas **propias** hace falta Rekognition **Custom Labels** (entrenar con imágenes
propias) o un modelo multimodal por Bedrock.

**El techo de `MaxLabels` es 1000.** Con `MaxLabels=1000, MinConfidence=0` devuelve exactamente 1000, la
última con 37.05 de confianza.

**Los filtros de `Settings.GeneralLabels` son el arreglo real del ruido de S01.** Medido:

```
LabelCategoryInclusionFilters: ["Apparel and Accessories"]
  -> Clothing 100 · Pants 100 · Vest 100 · Jeans 99.99 · Coat 99.98 · Jacket 99.98
LabelExclusionFilters: ["Pants", "Vest"]
  -> Clothing 100 · Jeans 99.99 · Coat 99.98 · Jacket 99.98      (las 4 correctas)
```

La categoría saca el ruido de muebles/animales sin tocar el umbral; la exclusión saca las dos etiquetas
que sabemos incorrectas, al costo de **hardcodear conocimiento del dominio** en la Lambda. S01 no usa
ninguno de los dos a propósito: la sesión enseña el comportamiento crudo del servicio.

**`Features: ["IMAGE_PROPERTIES"]` es otra llamada, no un extra gratis.** Con sólo ese feature devuelve
**0 labels** y a cambio da calidad y colores dominantes — medido en la chaqueta: brillo 76.35, nitidez
78.64, contraste 74.23, y `#778899` 36.50 % · `#2f4f4f` 19.50 % · `#a9a9a9` 14.58 %. Sirve para generar
la faceta "color" del catálogo sin que nadie la tipee. Para pedir ambas cosas hay que listar
`GENERAL_LABELS` **y** `IMAGE_PROPERTIES`.

**La respuesta trae más de lo que S01 guarda.** Cada label incluye `Parents`, `Categories`, `Aliases` e
`Instances` (bounding boxes). Ejemplo real: `Pants` llega con `Parents: [Clothing]` y
`Categories: [Apparel and Accessories]`. El handler se queda sólo con `name` + `confidence`; las
categorías serían la fuente natural de facetas de navegación si el catálogo las necesitara.

**El alt-text automático puede empeorar la accesibilidad.** Medido en S02, es un volcado de etiquetas, no
una frase:

```
Chaqueta de mezclilla oversize  ->  "Imagen de producto que muestra: Clothing, Pants, Vest, Jeans, Coat."
Vestido midi floral             ->  "Imagen de producto que muestra: Clothing, Dress, Evening Dress, Formal Wear, Person."
```

Dos problemas reales, no estéticos. **El de la chaqueta dice `Pants` y `Vest`**: son las etiquetas
incorrectas de S01, y acá se convierten en **información falsa leída en voz alta** a una persona que usa
lector de pantalla — que es exactamente a quien la función pretende ayudar. **El del vestido dice
`Person`** sobre un maniquí. Y ninguno menciona que la chaqueta es *de mezclilla* ni que el vestido es
*floral*, que es lo que un comprador querría saber.

Lección de D4: automatizar la accesibilidad **no** es lo mismo que lograrla. Un alt-text generado sirve
como borrador para que una persona lo edite; publicarlo sin revisar propaga los errores del modelo al
grupo más vulnerable. La versión decente de esto llega en S06 con Bedrock, que redacta prosa a partir de
las etiquetas en lugar de concatenarlas.

**La taxonomía de moderación tiene 52 categorías y las devuelve todas si se lo pedís.** Con
`MinConfidence=0` sobre las 4 fotos del catálogo (modelo `7.0`): el máximo es `0.95 %` en el vestido
(`Non-Explicit Nudity…`, por la piel del maniquí y el escote), `0.03 %` en el bolso, `0.01 %` en la
chaqueta y `0.01 %` en los tenis (`Weapons`, `Violence`). O sea: el umbral de 60 deja un margen de ~63×
sobre la señal más alta que producen fotos de catálogo normales. Sirve para justificar el umbral con
datos en vez de con intuición.

**`ItemCount` de `describe-table` miente por diseño.** Devolvía `0` con 4 productos cargados: DynamoDB
lo refresca cada ~6 horas. Para un conteo real,
`aws dynamodb scan --select COUNT`.

**Los logs no expiran.** El log group del router tiene `retentionInDays: None` — retención infinita.
`docs/COST_AND_CLEANUP.md` recomienda fijarla y los templates no lo hacen. Céntimos a este volumen,
pero es el tipo de cosa que S10 (gobernanza) debería cerrar.

**Nuestros JPEG no llevan hash de contenido.** Vite firma el JS y el CSS (`index-DZGslLjO.js`), así que
invalidan la caché de CloudFront solos. `products/vestido-floral.jpg` no: reemplazar una foto con el
mismo nombre exige
`aws cloudfront create-invalidation --paths "/products/*"`.

**El bucket es realmente público.** Su policy da `s3:GetObject` a `Principal: "*"` y los cuatro
switches de Block Public Access están en `false`. Es intencional (CloudFront lo lee como llamador
anónimo, con `OriginAccessIdentity` vacío), pero conviene decirlo en voz alta.

**La documentación promete portabilidad que el template ya no tiene.** Varias frases de `docs/IAM.md`,
`docs/SANDBOX-COMPAT.md` §2 y las guías dicen "cualquier cuenta con `iam:CreateRole`". Desde el commit
`615dffe` los tres templates hardcodean
`PermissionsBoundary: arn:aws:iam::281248178297:policy/techmoda-capstone-boundary`, así que en otra
cuenta hay que crear un boundary equivalente o quitar esa línea. `validate-all.sh` **no** chequea
account IDs hardcodeados.

**El snippet de S01 es más amplio que su propia tabla.** La `GUIA.md` documenta el `s3:GetObject`
acotado a `${StackName}-frontend/*`; el snippet realmente concede `${AWS::StackName}-*/*`, o sea
cualquier bucket del stack (incluido el de audio de S05). Diferencia menor, pero la doc y el código no
dicen lo mismo.

**La Function URL no tiene autenticación, a propósito.** `AuthType: NONE` y CORS `*`: cualquiera que
tenga la URL puede crear y borrar productos. Es adecuado para un lab y **no** para producción — y es la
razón por la que las URLs no se comitean (ver [`../evidence/README.md`](../evidence/README.md)).
