import RestbaseClient, {agg} from "./client/restbase-client.ts";

const client = new RestbaseClient("http://localhost:3000");
const products = client.table<{ id: number, name: string }>("products")
console.log(products.query().select("id", agg("count", "name")).exec())
