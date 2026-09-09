// Testa o checker com proxies FALSAS locais, cada uma com um comportamento conhecido.
//
// Nao da para testar contra a internet aqui: este ambiente so deixa sair TCP em 80/443, e proxy vive em
// porta alta. Entao as proxies sao montadas aqui do lado, uma para cada caso que importa.
import fs from "node:fs";
import net from "node:net";
import { sondar, checar, ranquear, lerFonte, lerMinhas, temCredencial, partirEndereco, juntarFontes, descobrirPaises } from "/home/user/asdasdasd/proxy-checker/api/_checker.js";

const resultados = [];
function check(nome, ok, detalhe) {
    resultados.push(ok);
    console.log(`${ok ? "  ok   " : " FALHA "}${nome}${!ok && detalhe ? " -- " + detalhe : ""}`);
}

// tipo: "udp" aceita ASSOCIATE | "socks" fala socks5 e recusa | "senha" exige autenticacao
//       "http" nao e socks5 | "mudo" atende e cala | "morta" nem escuta
//       "semBind" aceita o ASSOCIATE e devolve 0.0.0.0:0 -- o tipo mais enganoso de todos
function subir(tipo) {
    return new Promise(resolve => {
        if (tipo === "morta") return resolve({ porta: 1, fechar() { } });
        const s = net.createServer(c => {
            c.on("error", () => c.destroy());
            let etapa = 0;
            c.on("data", quadro => {
                if (tipo === "mudo") return;
                if (etapa === 0) {
                    etapa = 1;
                    if (tipo === "http") return c.write(Buffer.from("HTTP/1.1 400\r\n\r\n"));
                    if (tipo === "senha" || tipo === "login") {
                        // Uma SOCKS5 de verdade so escolhe um metodo que o cliente OFERECEU. Sem esta
                        // conferencia o dublê aceitava login de um cliente que nem sabe fazer login --
                        // e o teste passava mesmo com o plugin oferecendo so "sem autenticacao".
                        const oferecidos = quadro.subarray(2, 2 + quadro[1]);
                        if (!oferecidos.includes(2)) return c.write(Buffer.from([5, 0xff]));   // nenhum serve
                        return c.write(Buffer.from([5, 2]));   // 2 = usuario/senha
                    }
                    return c.write(Buffer.from([5, 0]));
                }

                // O dublê "login" exige credencial e aceita UMA: bob/sec. E o unico jeito de o teste
                // separar "senha certa" de "senha errada" -- que sao respostas diferentes e uteis.
                if (tipo === "login" && etapa === 1) {
                    etapa = 2;
                    const nu = quadro[1];
                    const usuario = quadro.subarray(2, 2 + nu).toString();
                    const ns = quadro[2 + nu];
                    const senha = quadro.subarray(3 + nu, 3 + nu + ns).toString();
                    return c.write(Buffer.from([1, usuario === "bob" && senha === "sec" ? 0 : 1]));
                }
                // resposta ao ASSOCIATE: 0 = aceito, 7 = comando nao suportado
                //
                // A "semBind" responde ACEITO e manda 0.0.0.0:0 como endereco de recepcao. Ela e a que
                // fazia o numero da tela mentir: passava como boa, e o cliente descobria depois que nao
                // havia para onde mandar datagrama.
                if (tipo === "semBind") return c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                // ATYP 3 = nome de dominio, com o tamanho no byte seguinte. Proxy de verdade responde
                // assim com frequencia, e a porta fica DEPOIS do nome -- ler no lugar fixo daria lixo.
                // Tipo de endereco que nao existe: nao da para saber onde a porta comeca, entao a
                // unica resposta honesta e recusar -- e nao chutar um deslocamento.
                if (tipo === "atypEstranho") return c.write(Buffer.from([5, 0, 0, 9, 1, 2, 3, 4, 0x04, 0x38]));
                // A resposta chega PARTIDA, como TCP entrega de verdade. Lendo antes de ela fechar, a
                // porta sai de bytes que ainda nem chegaram.
                if (tipo === "partida") {
                    const nome = Buffer.from("relay.exemplo", "utf8");
                    c.write(Buffer.concat([Buffer.from([5, 0, 0, 3, nome.length]), nome.subarray(0, 5)]));
                    setTimeout(() => c.write(Buffer.concat([nome.subarray(5), Buffer.from([0x04, 0x38])])), 60);
                    return;
                }
                if (tipo === "dominio") {
                    const nome = Buffer.from("relay.exemplo", "utf8");
                    return c.write(Buffer.concat([
                        Buffer.from([5, 0, 0, 3, nome.length]), nome, Buffer.from([0x04, 0x38])
                    ]));
                }
                // "login" tambem aceita o ASSOCIATE -- depois da senha certa ela e uma proxy boa
                // como qualquer outra, e e isso que o teste precisa poder afirmar.
                c.write(Buffer.from([5, tipo === "udp" || tipo === "login" ? 0 : 7, 0, 1, 127, 0, 0, 1, 4, 56]));
            });
        });
        s.listen(0, "127.0.0.1", () => resolve({ porta: s.address().port, fechar: () => s.close() }));
    });
}

const casos = ["udp", "socks", "senha", "http", "mudo", "morta", "semBind", "dominio", "atypEstranho", "partida", "login"];
const servidores = {};
for (const t of casos) servidores[t] = await subir(t);
const endereco = t => `127.0.0.1:${servidores[t].porta}`;

// ---- cada comportamento tem que ser classificado no lugar certo
for (const [tipo, esperada] of [["udp", "udp"], ["socks", "socks5"], ["senha", "tcp"], ["http", "tcp"], ["mudo", "tcp"], ["morta", "morta"], ["semBind", "socks5_sem_bind"], ["dominio", "udp"], ["atypEstranho", "socks5"], ["partida", "udp"]]) {
    const r = await sondar(endereco(tipo), { conectarMs: 800, aperoMs: 1200 });
    check(`"${tipo}" e classificada como ${esperada}`, r.fase === esperada, `veio ${r.fase}`);
}

// ---- so quem aceita ASSOCIATE entra no resultado
const todos = casos.map(endereco);
const { aprovadas, contagem } = await checar(todos, { paralelo: 6, orcamentoMs: 10_000, conectarMs: 800, aperoMs: 1200 });
check("so as que aceitam ASSOCIATE E devolvem bind usavel sao aprovadas",
    aprovadas.length === 3
    && aprovadas.some(a => a.endereco === endereco("udp"))
    && aprovadas.some(a => a.endereco === endereco("dominio")), JSON.stringify(aprovadas));
check("a contagem separa as fases", contagem.tcp === 10 && contagem.socks5 === 6 && contagem.udp === 3,
    JSON.stringify(contagem));

// A porta lida, e nao so a classificacao. 0x0438 = 1080, que e o que os dubles anunciam. Sem cobrar o
// numero, um deslocamento errado que caia por acaso num valor diferente de zero passa como boa.
for (const tipo of ["dominio", "partida"]) {
    const r = await sondar(endereco(tipo), { conectarMs: 800, aperoMs: 1200 });
    check(`a porta de recepcao de "${tipo}" e lida depois do nome, nao num lugar fixo`,
        r.bindPorta === 1080, `veio ${r.bindPorta}`);
}
const doIpv4 = await sondar(endereco("udp"), { conectarMs: 800, aperoMs: 1200 });
check("e com endereco IPv4 ela sai do lugar certo tambem", doIpv4.bindPorta === 1080,
    `veio ${doIpv4.bindPorta}`);

// O furo que fazia a tela dizer "84 com UDP" e o plugin achar um punhado: a proxy responde OK ao
// ASSOCIATE e manda 0.0.0.0:0 como endereco de recepcao. Passa em todo teste rapido e nao entrega nada.
check("a que promete e nao entrega NAO conta como com UDP", contagem.udp === 3, JSON.stringify(contagem));
check("mas e contada a parte, para o numero da tela se explicar", contagem.semBind === 1,
    JSON.stringify(contagem));
check("e ela conta como quem fala SOCKS5, porque fala mesmo", contagem.socks5 === 6,
    JSON.stringify(contagem));
check("proxy que exige senha nao passa: o plugin usa proxy aberta",
    !aprovadas.some(a => a.endereco === endereco("senha")), JSON.stringify(aprovadas));

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

// ---- as SUAS na frente, sempre
//
// Quem colou uma proxy propria escolheu aquela: sabe de onde ela sai e provavelmente pagou por ela. Uma
// gratuita e um endereco que respondeu hoje. Ordenar as duas pela mesma nota seria tratar como iguais
// duas coisas que ninguem trata como iguais -- e ai ter proxy propria nao adiantaria nada, porque a
// gratuita mais rapida do momento ganharia sempre.
const misturado = ranquear(
    [{ endereco: "6.6.6.6:6", ms: 700 }, { endereco: "7.7.7.7:7", ms: 80 }, { endereco: "8.8.8.8:8", ms: 400 }],
    new Map([["6.6.6.6:6", "US"], ["7.7.7.7:7", "US"], ["8.8.8.8:8", "US"]]),
    new Map([["6.6.6.6:6", "suas"], ["8.8.8.8:8", "suas"]])
);
check("a sua vem na frente mesmo sendo bem mais lenta", misturado[0].proxy === "socks5://8.8.8.8:8",
    misturado.map(p => `${p.fonte}:${p.ms}`).join(" "));
check("entre as suas, a melhor primeiro",
    misturado.slice(0, 2).map(p => p.proxy).join(",") === "socks5://8.8.8.8:8,socks5://6.6.6.6:6",
    misturado.map(p => p.proxy).join(","));
check("a gratuita rapida vem depois, e nao some",
    misturado[2].proxy === "socks5://7.7.7.7:7", misturado.map(p => p.proxy).join(","));
check("e cada linha diz se e sua, para o plugin e a tabela poderem mostrar",
    misturado.filter(p => p.minha === true).length === 2
    && misturado.find(p => p.proxy === "socks5://7.7.7.7:7").minha === false,
    JSON.stringify(misturado.map(p => [p.proxy, p.minha])));

// ---- leitura dos formatos das fontes
const paises = new Map();
check("le ip:porta puro", lerFonte("9.9.9.9:1080\nlixo\n", paises).join() === "9.9.9.9:1080");
check("le socks5://", lerFonte("socks5://8.8.8.8:1080\n", paises).join() === "8.8.8.8:1080");
check("le JSON com pais", lerFonte(JSON.stringify([{ ip: "7.7.7.7", port: 1, geolocation: { country: "AR" } }]), paises).join() === "7.7.7.7:1");
check("e guarda o pais do JSON", paises.get("7.7.7.7:1") === "AR", paises.get("7.7.7.7:1"));
lerFonte("6.6.6.6:1080:Brazil\n", paises);
check("e o pais por extenso do hideip.me", paises.get("6.6.6.6:1080") === "BR", paises.get("6.6.6.6:1080"));

// ---- proxy com usuario e senha
//
// O aperto de mao de credencial do SOCKS5 (RFC 1929). Sem ele, proxy paga -- que e a que costuma
// funcionar de verdade -- nao tinha como ser testada aqui.
const comSenhaCerta = await sondar(`bob:sec@${endereco("login")}`, { conectarMs: 800, aperoMs: 1200 });
check("proxy que exige senha passa com a credencial certa", comSenhaCerta.fase === "udp",
    `veio ${comSenhaCerta.fase}`);
check("e o bind e lido igual ao das abertas", comSenhaCerta.bindPorta === 1080, String(comSenhaCerta.bindPorta));

// Senha errada NAO e "endereco morto": a proxy existe e fala SOCKS5, so nao com essa credencial. Sao
// problemas diferentes, e quem colou a lista precisa saber qual dos dois e o dele.
const comSenhaErrada = await sondar(`bob:errada@${endereco("login")}`, { conectarMs: 800, aperoMs: 1200 });
check("senha errada e classificada como senha recusada", comSenhaErrada.fase === "senha_recusada",
    `veio ${comSenhaErrada.fase}`);

// Sem mandar credencial, a mesma proxy e so uma que exige senha -- o mesmo caso de sempre.
const semMandar = await sondar(endereco("login"), { conectarMs: 800, aperoMs: 1200 });
check("sem credencial, ela cai no caso de sempre (exige senha)", semMandar.fase === "tcp",
    `veio ${semMandar.fase}`);

// A credencial anda AO LADO do endereco, nunca dentro dele: e o que impede ela de entrar em contagem,
// resumo, cache ou linha de registro sem ninguem perceber.
check("o endereco e a credencial sao separados",
    JSON.stringify(partirEndereco("bob:sec@1.2.3.4:1080")) === JSON.stringify({ endereco: "1.2.3.4:1080", usuario: "bob", senha: "sec" }),
    JSON.stringify(partirEndereco("bob:sec@1.2.3.4:1080")));
check("e sem credencial o endereco vem inteiro",
    partirEndereco("1.2.3.4:1080").usuario === null);

// ---- as proxies que a pessoa cola
//
// O endpoint e publico: sem peneira e sem teto ele viraria um scanner de porta para qualquer um
// apontar onde quisesse, com o IP do site na frente.
check("le ip:porta e socks5://", lerMinhas("1.2.3.4:1080, socks5://5.6.7.8:9050").join() === "1.2.3.4:1080,5.6.7.8:9050",
    JSON.stringify(lerMinhas("1.2.3.4:1080, socks5://5.6.7.8:9050")));
check("separadas por virgula, espaco ou linha",
    lerMinhas("1.1.1.1:1\n2.2.2.2:2;3.3.3.3:3 4.4.4.4:4").length === 4,
    JSON.stringify(lerMinhas("1.1.1.1:1\n2.2.2.2:2;3.3.3.3:3 4.4.4.4:4")));
// Credencial NAO passa por aqui: mandar usuario e senha para um site publico e pedir para vazar.
check("aceita user:senha@ip:porta", lerMinhas("user:pw@9.9.9.9:1080").join() === "user:pw@9.9.9.9:1080",
    JSON.stringify(lerMinhas("user:pw@9.9.9.9:1080")));
// Formato que muito vendedor entrega. Vira o outro, para so existir uma forma daqui para baixo.
check("aceita ip:porta:user:senha e converte", lerMinhas("9.9.9.9:1080:bob:sec").join() === "bob:sec@9.9.9.9:1080",
    JSON.stringify(lerMinhas("9.9.9.9:1080:bob:sec")));
check("credencial pela metade nao passa",
    lerMinhas("user@9.9.9.9:1080 :pw@8.8.8.8:1080 user:@7.7.7.7:1080").length === 0,
    JSON.stringify(lerMinhas("user@9.9.9.9:1080 :pw@8.8.8.8:1080 user:@7.7.7.7:1080")));
// O mesmo endereco colado duas vezes e uma proxy so, e fica a versao que tem chance de passar.
check("mesmo endereco com e sem senha vira um so, com a senha",
    lerMinhas("9.9.9.9:1080 bob:sec@9.9.9.9:1080").join() === "bob:sec@9.9.9.9:1080",
    JSON.stringify(lerMinhas("9.9.9.9:1080 bob:sec@9.9.9.9:1080")));
check("temCredencial separa as duas listas",
    temCredencial(lerMinhas("bob:sec@9.9.9.9:1080")) === true && temCredencial(lerMinhas("9.9.9.9:1080")) === false);
check("recusa lixo e porta fora da faixa", lerMinhas("lixo 10.0.0.1:70000 10.0.0.2:0").length === 0,
    JSON.stringify(lerMinhas("lixo 10.0.0.1:70000 10.0.0.2:0")));
check("nao repete endereco", lerMinhas("1.2.3.4:1080 1.2.3.4:1080").length === 1);
check("e tem teto", lerMinhas(Array.from({ length: 80 }, (_, i) => `10.0.0.${i}:1080`).join(","), 50).length === 50);
check("texto vazio nao vira nada", lerMinhas("").length === 0 && lerMinhas(null).length === 0);

// As suas entram na FRENTE: quem colou um endereco quer ele testado, e nao no fim de uma fila de
// milhares. E como fonte propria, senao sumiriam dentro do numero das listas publicas.
const comMinhas = await juntarFontes({ prazoFonte: 8000, teto: 200, minhas: ["203.0.113.7:1080", "198.51.100.9:9050"] });
check("as suas vao para a frente da fila",
    comMinhas.enderecos.slice(0, 2).includes("203.0.113.7:1080"), comMinhas.enderecos.slice(0, 4).join(","));
check("e aparecem como fonte propria no resumo",
    comMinhas.resumo.some(f => f.fonte === "suas" && f.total === 2), JSON.stringify(comMinhas.resumo.find(f => f.fonte === "suas")));

// ---- descobrir o pais nao pode custar proxy da lista
//
// Este e o ponto que ja quebrou do outro lado: o plugin abria uma volta ate a Cloudflare por proxy so
// para saber o pais e, quando ela falhava, REPROVAVA a proxy -- por uma pergunta que nem era sobre
// datagrama. O site entregava 79 e sobravam 5. Aqui a volta acontece uma vez, e falhar tem que ser
// aceitavel: sai "??" e a proxy continua na lista.
const paisesTeste = new Map();
const aprovadasTeste = [
    { endereco: endereco("udp"), ms: 5 },       // fala socks5, mas recusa CONNECT -> nao da para saber
    { endereco: endereco("morta"), ms: 5 },     // nem escuta
    { endereco: endereco("dominio"), ms: 5 }
];
paisesTeste.set(endereco("dominio"), "US");    // esta ja veio com pais da propria lista

const geo = await descobrirPaises(aprovadasTeste, paisesTeste, { paralelo: 4, orcamentoMs: 4000, prazoMs: 800 });
check("so procura pais de quem ainda nao tem", geo.pedidos === 2, JSON.stringify(geo));
check("quem ja tinha pais nao e mexida", paisesTeste.get(endereco("dominio")) === "US",
    paisesTeste.get(endereco("dominio")));

const comGeo = ranquear(aprovadasTeste, paisesTeste, new Map());
check("nenhuma proxy some por nao se saber o pais dela", comGeo.length === 3, JSON.stringify(comGeo));
check("as sem pais saem como ??",
    comGeo.filter(p => p.pais === "??").length === 2, JSON.stringify(comGeo.map(p => p.pais)));
// "??" paga o fator de pais mais alto: qualquer saida de pais conhecido passa na frente dela, mas ela
// continua utilizavel como reserva -- que e melhor que nao ter reserva nenhuma.
check("e ficam atras da que tem pais conhecido", comGeo[0].pais === "US", JSON.stringify(comGeo.map(p => p.pais)));

// O orcamento e um teto de verdade: sem ele, uma leva de proxies mudas seguraria a funcao inteira ate
// a Vercel cortar, e a resposta se perderia.
const mudas = Array.from({ length: 40 }, () => ({ endereco: endereco("mudo"), ms: 5 }));
const geoT0 = Date.now();
await descobrirPaises(mudas, new Map(), { paralelo: 4, orcamentoMs: 1200, prazoMs: 5000 });
const geoLevou = Date.now() - geoT0;
check("o orcamento da descoberta de pais e respeitado", geoLevou < 8000, `levou ${geoLevou}ms`);

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
