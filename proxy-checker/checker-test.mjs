// Testa o checker com proxies FALSAS locais, cada uma com um comportamento conhecido.
//
// Nao da para testar contra a internet aqui: este ambiente so deixa sair TCP em 80/443, e proxy vive em
// porta alta. Entao as proxies sao montadas aqui do lado, uma para cada caso que importa.
import fs from "node:fs";
import net from "node:net";
import { sondar, checar, ranquear, lerFonte } from "/home/user/asdasdasd/proxy-checker/api/_checker.js";

const resultados = [];
function check(nome, ok, detalhe) {
    resultados.push(ok);
    console.log(`${ok ? "  ok   " : " FALHA "}${nome}${!ok && detalhe ? " -- " + detalhe : ""}`);
}

// tipo: "udp" aceita ASSOCIATE | "socks" fala socks5 e recusa | "senha" exige autenticacao
//       "http" nao e socks5 | "mudo" atende e cala | "morta" nem escuta
function subir(tipo) {
    return new Promise(resolve => {
        if (tipo === "morta") return resolve({ porta: 1, fechar() { } });
        const s = net.createServer(c => {
            c.on("error", () => c.destroy());
            let etapa = 0;
            c.on("data", () => {
                if (tipo === "mudo") return;
                if (etapa === 0) {
                    etapa = 1;
                    if (tipo === "http") return c.write(Buffer.from("HTTP/1.1 400\r\n\r\n"));
                    if (tipo === "senha") return c.write(Buffer.from([5, 2]));   // 2 = usuario/senha
                    return c.write(Buffer.from([5, 0]));
                }
                // resposta ao ASSOCIATE: 0 = aceito, 7 = comando nao suportado
                c.write(Buffer.from([5, tipo === "udp" ? 0 : 7, 0, 1, 127, 0, 0, 1, 4, 56]));
            });
        });
        s.listen(0, "127.0.0.1", () => resolve({ porta: s.address().port, fechar: () => s.close() }));
    });
}

const casos = ["udp", "socks", "senha", "http", "mudo", "morta"];
const servidores = {};
for (const t of casos) servidores[t] = await subir(t);
const endereco = t => `127.0.0.1:${servidores[t].porta}`;

// ---- cada comportamento tem que ser classificado no lugar certo
for (const [tipo, esperada] of [["udp", "udp"], ["socks", "socks5"], ["senha", "tcp"], ["http", "tcp"], ["mudo", "tcp"], ["morta", "morta"]]) {
    const r = await sondar(endereco(tipo), { conectarMs: 800, aperoMs: 1200 });
    check(`"${tipo}" e classificada como ${esperada}`, r.fase === esperada, `veio ${r.fase}`);
}

// ---- so quem aceita ASSOCIATE entra no resultado
const todos = casos.map(endereco);
const { aprovadas, contagem } = await checar(todos, { paralelo: 6, orcamentoMs: 10_000, conectarMs: 800, aperoMs: 1200 });
check("so a que aceita ASSOCIATE e aprovada",
    aprovadas.length === 1 && aprovadas[0].endereco === endereco("udp"), JSON.stringify(aprovadas));
check("a contagem separa as fases", contagem.tcp === 5 && contagem.socks5 === 2 && contagem.udp === 1,
    JSON.stringify(contagem));
check("proxy que exige senha nao passa: o plugin usa proxy aberta", contagem.socks5 === 2,
    `socks5=${contagem.socks5}`);

// ---- o orcamento de tempo e respeitado, e o que sobrou fica dito
const muitas = Array.from({ length: 400 }, () => endereco("mudo"));
const comeco = Date.now();
const parcial = await checar(muitas, { paralelo: 4, orcamentoMs: 1500, conectarMs: 800, aperoMs: 1200 });
const levou = Date.now() - comeco;
check("o orcamento de tempo e respeitado", levou < 4000, `${levou}ms`);
check("e ele diz que nao terminou a lista", parcial.completou === false, `${parcial.completou}`);

// ---- ordenacao: o pais entra como fator, nao como primeira chave
const ranque = ranquear(
    [{ endereco: "1.1.1.1:1", ms: 300 }, { endereco: "2.2.2.2:2", ms: 60 }, { endereco: "3.3.3.3:3", ms: 90 }],
    new Map([["1.1.1.1:1", "US"], ["2.2.2.2:2", "AR"], ["3.3.3.3:3", "SG"]]),
    new Map()
);
check("uma vizinha rapida ganha de uma americana lenta", ranque[0].proxy === "socks5://2.2.2.2:2",
    ranque.map(p => `${p.pais}:${p.pontos}`).join(" "));
// A distante SO ganha se for MUITO mais rapida -- e a diferenca tem que ser grande, nao qualquer uma.
// (A primeira versao desta checagem exigia que a distante ficasse sempre por ultimo, que e justamente o
// raciocinio lexicografico que o fator multiplicativo veio substituir: ali o pais decidia antes de o
// tempo ser olhado.)
const perto = ranquear(
    [{ endereco: "4.4.4.4:4", ms: 250 }, { endereco: "5.5.5.5:5", ms: 300 }],
    new Map([["4.4.4.4:4", "SG"], ["5.5.5.5:5", "US"]]),
    new Map()
);
check("uma distante so um pouco mais rapida NAO ganha da americana",
    perto[0].pais === "US", perto.map(p => `${p.pais}:${p.pontos}`).join(" "));
check("mas uma distante MUITO mais rapida ganha",
    ranque.findIndex(p => p.pais === "SG") === 1, ranque.map(p => `${p.pais}:${p.pontos}`).join(" "));
check("a saida ja vem no formato que o plugin le",
    ranque.every(p => /^socks5:\/\/\d+(\.\d+){3}:\d+$/.test(p.proxy)), ranque[0].proxy);

// ---- leitura dos formatos das fontes
const paises = new Map();
check("le ip:porta puro", lerFonte("9.9.9.9:1080\nlixo\n", paises).join() === "9.9.9.9:1080");
check("le socks5://", lerFonte("socks5://8.8.8.8:1080\n", paises).join() === "8.8.8.8:1080");
check("le JSON com pais", lerFonte(JSON.stringify([{ ip: "7.7.7.7", port: 1, geolocation: { country: "AR" } }]), paises).join() === "7.7.7.7:1");
check("e guarda o pais do JSON", paises.get("7.7.7.7:1") === "AR", paises.get("7.7.7.7:1"));
lerFonte("6.6.6.6:1080:Brazil\n", paises);
check("e o pais por extenso do hideip.me", paises.get("6.6.6.6:1080") === "BR", paises.get("6.6.6.6:1080"));

// ---- o vercel.json tem que subir no plano gratuito
//
// Esta checagem existe porque ja custou um deploy. Um cron mais frequente que diario nao e ignorado no
// plano Hobby: ele RECUSA o deploy inteiro ("Hobby accounts are limited to daily cron jobs"), e o
// projeto simplesmente nao sobe. O piso que o cron daria nao vale isso -- quem renova a lista aqui e o
// trafego, pelo s-maxage de um minuto.
const vercel = JSON.parse(fs.readFileSync(new URL("./vercel.json", import.meta.url), "utf8"));
const crons = vercel.crons ?? [];
check("o vercel.json nao traz cron mais frequente que diario", crons.every(c => {
    const [minuto, hora] = String(c.schedule ?? "").split(/\s+/);
    // Diario e um minuto fixo numa hora fixa. Qualquer coringa ou passo nesses dois campos ja quer
    // dizer mais de uma vez por dia.
    return /^\d+$/.test(minuto ?? "") && /^\d+$/.test(hora ?? "");
}), JSON.stringify(crons));

// maxDuration acima de 60s tambem recusa o deploy no plano gratuito.
const prazo = vercel.functions?.["api/proxies.js"]?.maxDuration ?? 0;
check("e o maxDuration cabe no plano gratuito", prazo <= 60, String(prazo));
// E o orcamento da varredura tem que caber DENTRO dele, senao a funcao e cortada no meio e a resposta
// se perde -- em vez de devolver o que deu tempo de testar com completou: false.
check("e o orcamento da varredura cabe dentro do maxDuration",
    45_000 < prazo * 1000, `orcamento 45000ms, maxDuration ${prazo * 1000}ms`);

for (const t of casos) servidores[t].fechar();

const falhou = resultados.filter(ok => !ok).length;
console.log("");
console.log(falhou === 0 ? `TODOS OS ${resultados.length} TESTES PASSARAM` : `${falhou} de ${resultados.length} FALHARAM`);
process.exit(falhou === 0 ? 0 : 1);
