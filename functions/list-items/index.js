/**
 * LIST ITEMS FUNCTION
 *
 * Purpose: Return all products in the catalog
 * API Endpoint: GET /products
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

// Create DynamoDB client
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.PRODUCTS_TABLE;

// CORS lo emite el FunctionUrlConfig.Cors del template (capa de plataforma).
// Si el handler lo manda TAMBIEN, la respuesta lleva dos Access-Control-Allow-Origin
// y el navegador la rechaza con "Failed to fetch". curl no lo nota: sin header Origin,
// la Function URL no agrega el suyo y solo se ve uno.
exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));

    try {
        // Scan the DynamoDB table to get all products
        const command = new ScanCommand({
            TableName: TABLE_NAME
        });

        const result = await dynamodb.send(command);

        console.log(`Retrieved ${result.Items.length} products`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                products: result.Items || []
            })
        };
    } catch (error) {
        console.error('Error listing products:', error);

        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Error al listar productos',
                message: error.message
            })
        };
    }
};
