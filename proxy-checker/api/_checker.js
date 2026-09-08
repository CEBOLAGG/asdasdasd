// O checker: junta as listas publicas, testa cada endereco e devolve so o que presta, ordenado.
//
// POR QUE ISTO EXISTE
//
// O plugin sozinho precisa testar dezenas de milhares de enderecos na maquina de quem usa -- e a
// esmagadora maioria esta morta. Isso gasta minutos de rede do usuario para achar meia duzia de
// proxies. Fazendo a peneira aqui, uma vez, todo mundo recebe a lista curta ja limpa.
//
// O QUE ESTE CHECKER CONSEGUE PROVAR (e o que nao consegue)
//
// A funcao serverless da Vercel fala TCP, mas NAO fala UDP -- nao da para enviar datagrama de la. Entao
// aqui se prova:
//
//   - o endereco atende TCP;
//   - fala SOCKS5 sem exigir senha;
//   - e RESPONDE OK ao pedido de UDP ASSOCIATE.
//
// O que fica de fora e a ultima milha: se o datagrama realmente atravessa. Uma proxy pode aceitar o
// ASSOCIATE e nao entregar nada -- e o pior tipo, justamente porque passa em todo teste rapido. Essa
// prova continua sendo do plugin, na maquina de quem usa. A diferenca e que ele faz isso numa lista de
// dezenas em vez de dezenas de milhares.

import net from "node:net";

export const FONTES = [
    { nome: "proxyscrape", url: "https://raw.githubusercontent.com/ProxyScrape/free-proxy-list/main/proxies/protocols/socks5/data.txt" },
    { nome: "thespeedx", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt" },
    { nome: "proxifly", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.json" },
    { nome: "hookzof", url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt" },
    { nome: "monosans", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt" },
    { nome: "hideip", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt" },
    // Estas duas sao listas CURADAS: quem publica ja testou antes de publicar. Densidade de acerto
    // muito maior por endereco olhado do que uma varredura em massa.
    { nome: "cmahmud", url: "https://raw.githubusercontent.com/cmahmud/proxies/refs/heads/main/alive/socks5.txt" },
    { nome: "dpangestuw", url: "https://raw.githubusercontent.com/dpangestuw/Free-Proxy/refs/heads/main/socks5_proxies.txt" }
];

const PAIS_POR_NOME = new Map([
    ["united states", "US"], ["canada", "CA"], ["mexico", "MX"], ["brazil", "BR"],
    ["argentina", "AR"], ["chile", "CL"], ["colombia", "CO"], ["peru", "PE"],
    ["uruguay", "UY"], ["ecuador", "EC"], ["panama", "PA"], ["costa rica", "CR"],
    ["dominican republic", "DO"]
]);

// Perto de quem? Do servidor de midia do Discord na America. Saida longe faz o ping da call subir
// muito mais do que o numero do handshake sugere, entao o pais entra como FATOR na ordenacao -- nao
// como primeira chave, senao uma americana lenta ganharia de uma vizinha rapida sempre.
const PERTO = new Set(["US", "MX", "CA", "CL", "AR", "CO", "PA", "PE", "EC", "UY", "CR", "DO"]);

function fatorDePais(pais) {
    if (pais === "US") return 1;
    if (pais === "MX" || pais === "CA") return 1.15;
    if (PERTO.has(pais)) return 1.3;
    if (pais === "??") return 1.4;
    return 2.2;
}

export function lerFonte(corpo, paises) {
    const achados = [];
    const texto = String(corpo).trim();

    // proxifly publica JSON com geolocalizacao, e o pais sai de graca -- descobrir pais por conta
    // propria custaria uma conexao a mais por endereco.
    if (texto.startsWith("[")) {
        try {
            const dados = JSON.parse(texto);
            if (Array.isArray(dados)) {
                for (const item of dados) {
                    if (typeof item?.ip !== "string" || typeof item?.port !== "number") continue;
                    const endereco = `${item.ip}:${item.port}`;
                    achados.push(endereco);
                    const pais = item?.geolocation?.country;
                    if (typeof pais === "string" && /^[A-Z]{2}$/.test(pais)) paises.set(endereco, pais);
                }
                return achados;
            }
        } catch { /* nao era JSON de verdade; cai no leitor de linhas */ }
    }

    for (const linha of texto.split(/\r?\n/)) {
        const achado = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/.exec(linha);
        if (achado === null) continue;
        const porta = Number(achado[2]);
        if (porta < 1 || porta > 65535) continue;

        const endereco = `${achado[1]}:${porta}`;
        achados.push(endereco);

        // hideip.me escreve "ip:porta:Pais".
        const resto = linha.slice(achado.index + achado[0].length).replace(/^[:\s]+/, "").trim();
        if (resto === "") continue;
        const codigo = PAIS_POR_NOME.get(resto.toLowerCase());
        if (codigo !== undefined) paises.set(endereco, codigo);
        else if (/^[A-Z]{2}$/.test(resto)) paises.set(endereco, resto);
    }

    return achados;
}

async function baixar(url, prazoMs) {
    const corte = AbortSignal.timeout(prazoMs);
    const resposta = await fetch(url, { signal: corte, headers: { "user-agent": "golive-proxy-checker" } });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return resposta.text();
}

export async function juntarFontes({ prazoFonte = 20_000, teto = 40_000 } = {}) {
    const paises = new Map();
    const origem = new Map();

    const respostas = await Promise.allSettled(
        FONTES.map(async f => ({ fonte: f, corpo: await baixar(f.url, prazoFonte) }))
    );

    const vistas = new Set();
    const porFonte = [];
    const resumo = [];

    for (const r of respostas) {
        if (r.status !== "fulfilled") {
            resumo.push({ fonte: FONTES[respostas.indexOf(r)]?.nome ?? "?", erro: true, total: 0, novas: 0 });
            continue;
        }
        const achados = lerFonte(r.value.corpo, paises);
        const minhas = [];
        for (const endereco of achados) {
            if (vistas.has(endereco)) continue;
            vistas.add(endereco);
            minhas.push(endereco);
            origem.set(endereco, r.value.fonte.nome);
        }
        porFonte.push(minhas);
        resumo.push({ fonte: r.value.fonte.nome, erro: false, total: achados.length, novas: minhas.length });
    }

    // INTERCALADO. Uma das fontes tem ~120 mil enderecos e as outras algumas centenas; emendadas em
    // fila, a grande ocuparia sozinha todo o orcamento de teste e as pequenas -- que sao mais densas em
    // proxy que presta -- nunca seriam olhadas.
    const juntas = [];
    for (let i = 0; juntas.length < teto; i++) {
        let alguem = false;
        for (const lista of porFonte) {
            if (i >= lista.length) continue;
            juntas.push(lista[i]);
            alguem = true;
            if (juntas.length >= teto) break;
        }
        if (!alguem) break;
    }

    return { enderecos: juntas, paises, origem, resumo, totalUnico: vistas.size };
}

// Uma sonda: TCP, aperto de mao SOCKS5 e o pedido de UDP ASSOCIATE. Devolve ate onde ela chegou.
//
// As fases sao separadas de proposito, com prazos diferentes: quem nao atende o TCP nao merece o prazo
// grande, e numa lista publica isso e a esmagadora maioria.
export function sondar(endereco, { conectarMs = 1200, aperoMs = 2500 } = {}) {
    return new Promise(resolve => {
        const corte = endereco.lastIndexOf(":");
        const host = endereco.slice(0, corte);
        const porta = Number(endereco.slice(corte + 1));

        const comecou = Date.now();
        const socket = net.connect({ host, port: porta });
        let fase = "morta";
        let pronto = false;
        let buffer = Buffer.alloc(0);

        // A porta de recepcao que a proxy anunciou. Sai junto do resultado para que a leitura da
        // resposta seja verificavel de fora: sem ela, um erro de deslocamento que por acaso caia num
        // numero diferente de zero classifica a proxy como boa e ninguem percebe.
        let bindPorta = null;

        const fim = () => {
            if (pronto) return;
            pronto = true;
            socket.destroy();
            resolve({ fase, ms: Date.now() - comecou, bindPorta });
        };

        const relogioTcp = setTimeout(fim, conectarMs);
        let relogioAperto = null;

        socket.on("error", fim);
        socket.on("close", fim);
        socket.once("connect", () => {
            clearTimeout(relogioTcp);
            fase = "tcp";
            relogioAperto = setTimeout(fim, aperoMs);
            socket.write(Buffer.from([5, 1, 0]));   // so "sem autenticacao"
        });

        socket.on("data", pedaco => {
            buffer = Buffer.concat([buffer, pedaco]);

            if (fase === "tcp") {
                if (buffer.length < 2) return;
                // 5 = socks5, 0 = sem autenticacao. Qualquer outra coisa (socks4, http, ou pedindo
                // senha) nao serve: o plugin usa proxy aberta.
                if (buffer[0] !== 5 || buffer[1] !== 0) return fim();
                fase = "socks5";
                buffer = buffer.subarray(2);
                socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));   // UDP ASSOCIATE
                return;
            }

            if (fase === "socks5") {
                // A resposta do ASSOCIATE nao termina no byte de sucesso: vem endereco e porta em que a
                // proxy vai receber os datagramas. Sao 4 bytes de cabecalho + o endereco + 2 de porta.
                if (buffer.length < 5) return;
                if (buffer[1] !== 0) { clearTimeout(relogioAperto); return fim(); }

                const tipo = buffer[3];
                const tamanho = tipo === 1 ? 4 : tipo === 3 ? 1 + buffer[4] : tipo === 4 ? 16 : -1;
                if (tamanho < 0) { clearTimeout(relogioAperto); return fim(); }
                if (buffer.length < 4 + tamanho + 2) return;

                // Em try: quem responde do outro lado e uma proxy desconhecida, e uma resposta
                // malformada nao pode derrubar a varredura inteira -- ela e so mais uma que nao serve.
                let porta;
                try { porta = buffer.readUInt16BE(4 + tamanho); }
                catch { clearTimeout(relogioAperto); return fim(); }
                bindPorta = porta;
                clearTimeout(relogioAperto);

                // PORTA ZERO NAO SERVE, e este era o furo: o checker dizia "84 com UDP" e o plugin
                // achava um punhado, porque boa parte respondia OK e devolvia bind 0.0.0.0:0 -- um
                // endereco para onde nao da para mandar datagrama nenhum. Contar essas como boas fazia o
                // numero da tela nao querer dizer nada, e ainda enchia a lista do plugin de endereco que
                // ele so ia descartar depois de gastar uma sonda em cada.
                if (porta !== 0) fase = "udp";
                else fase = "socks5_sem_bind";
                return fim();
            }
        });
    });
}

// Testa com concorrencia limitada e prazo de parede. O prazo existe porque isto roda numa funcao com
// tempo maximo: e melhor devolver o que deu tempo de testar do que ser cortado no meio e nao devolver
// nada.
export async function checar(enderecos, { paralelo = 300, orcamentoMs = 45_000, ...opcoes } = {}) {
    const aprovadas = [];
    const contagem = { testadas: 0, tcp: 0, socks5: 0, semBind: 0, udp: 0 };
    const prazo = Date.now() + orcamentoMs;

    let proximo = 0;
    async function trabalhador() {
        while (proximo < enderecos.length && Date.now() < prazo) {
            const endereco = enderecos[proximo++];
            const { fase, ms } = await sondar(endereco, opcoes);

            contagem.testadas++;
            if (fase !== "morta") contagem.tcp++;
            if (fase === "socks5" || fase === "socks5_sem_bind" || fase === "udp") contagem.socks5++;
            // Contada a parte, e nao junto das boas: a que aceita o ASSOCIATE e devolve porta 0 e o
            // tipo mais enganoso que existe aqui -- passa em todo teste rapido e nao entrega nada.
            // Mostrar quantas sao explica, na propria tela, por que "com UDP" e bem menor que "falam
            // SOCKS5".
            if (fase === "socks5_sem_bind") contagem.semBind++;
            if (fase === "udp") { contagem.udp++; aprovadas.push({ endereco, ms }); }
        }
    }

    await Promise.all(Array.from({ length: Math.min(paralelo, enderecos.length) }, trabalhador));
    return { aprovadas, contagem, completou: proximo >= enderecos.length };
}

export function ranquear(aprovadas, paises, origem) {
    return aprovadas
        .map(({ endereco, ms }) => {
            const pais = paises.get(endereco) ?? "??";
            return {
                proxy: `socks5://${endereco}`,
                ms,
                pais,
                fonte: origem.get(endereco) ?? "?",
                // Quanto menor, melhor. O pais multiplica em vez de decidir antes: uma vizinha bem mais
                // rapida tem que poder ganhar de uma americana lenta.
                pontos: Math.round(ms * fatorDePais(pais))
            };
        })
        .sort((a, b) => a.pontos - b.pontos);
}
