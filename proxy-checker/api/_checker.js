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
import tls from "node:tls";

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

// Le enderecos colados a mao. Mesmos formatos que as listas publicas usam, porque e de la que as
// pessoas copiam: "ip:porta", "socks5://ip:porta", separados por virgula, espaco ou quebra de linha.
// Aceita "ip:porta", "user:senha@ip:porta" e "ip:porta:user:senha" -- os tres formatos em que as
// pessoas realmente tem os enderecos anotados.
//
// Sobre a credencial: ela vai para a proxy no aperto de mao e nao aparece em lugar nenhum depois --
// nem na resposta, nem no cache, nem no resumo. A chave em todas as estruturas e o endereco puro. E o
// endpoint recusa credencial vinda por GET: URL fica em registro de servidor, historico e cache
// compartilhado. Com senha, so por POST, que nao e cacheado.
export function lerMinhas(bruto, teto = 50) {
    if (typeof bruto !== "string" || bruto.trim() === "") return [];

    const vistos = new Map();
    for (const pedaco of bruto.split(/[\s,;]+/)) {
        let limpo = pedaco.trim().replace(/^socks5:\/\//i, "");
        if (limpo === "") continue;

        // "ip:porta:user:senha" (o formato que muito vendedor entrega) vira "user:senha@ip:porta",
        // para so existir uma forma daqui para baixo.
        const quatro = /^([\d.]+):(\d{1,5}):([^:@\s]+):([^:@\s]+)$/.exec(limpo);
        if (quatro !== null) limpo = `${quatro[3]}:${quatro[4]}@${quatro[1]}:${quatro[2]}`;

        const arroba = limpo.lastIndexOf("@");
        const endereco = arroba < 0 ? limpo : limpo.slice(arroba + 1);
        const credencial = arroba < 0 ? "" : limpo.slice(0, arroba);

        if (!/^[\d.]+:\d{1,5}$/.test(endereco)) continue;
        const porta = Number(endereco.slice(endereco.lastIndexOf(":") + 1));
        if (porta < 1 || porta > 65535) continue;
        // Credencial existe? Entao precisa ter as duas partes, e nenhuma vazia.
        if (arroba >= 0 && !/^[^:@\s]+:[^:@\s]+$/.test(credencial)) continue;

        // Chaveado pelo ENDERECO: o mesmo host:porta colado duas vezes, com e sem senha, e uma proxy
        // so. Fica a versao com credencial, que e a que tem chance de passar.
        if (!vistos.has(endereco) || credencial !== "") vistos.set(endereco, limpo);
        if (vistos.size >= teto) break;
    }
    return [...vistos.values()];
}

// Tem credencial? Serve para o endpoint decidir se aquilo pode ter vindo por GET.
export function temCredencial(lista) {
    return lista.some(e => e.includes("@"));
}

export async function juntarFontes({ prazoFonte = 20_000, teto = 40_000, minhas = [] } = {}) {
    const paises = new Map();
    const origem = new Map();
    const credenciais = new Map();

    const respostas = await Promise.allSettled(
        FONTES.map(async f => ({ fonte: f, corpo: await baixar(f.url, prazoFonte) }))
    );

    const vistas = new Set();
    const porFonte = [];
    const resumo = [];

    // As suas entram PRIMEIRO, e como fonte propria.
    //
    // Primeiro porque quem colou um endereco quer ele testado, e nao no fim de uma fila de milhares.
    // Como fonte propria porque assim o resumo mostra quantas voce mandou e quantas eram novas -- do
    // contrario elas sumiriam dentro do numero das listas publicas.
    if (minhas.length > 0) {
        for (const bruto of minhas) {
            const { endereco } = partirEndereco(bruto);
            vistas.add(endereco);
            origem.set(endereco, "suas");
            // A credencial fica AQUI, fora da lista de enderecos: assim ela nunca entra numa estrutura
            // que depois vira resposta, cache ou linha de registro.
            if (bruto !== endereco) credenciais.set(endereco, bruto);
        }
        porFonte.push(minhas.map(b => partirEndereco(b).endereco));
        resumo.push({ fonte: "suas", erro: false, total: minhas.length, novas: minhas.length });
    }

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

    return { enderecos: juntas, paises, origem, credenciais, resumo, totalUnico: vistas.size };
}

// Uma sonda: TCP, aperto de mao SOCKS5 e o pedido de UDP ASSOCIATE. Devolve ate onde ela chegou.
//
// As fases sao separadas de proposito, com prazos diferentes: quem nao atende o TCP nao merece o prazo
// grande, e numa lista publica isso e a esmagadora maioria.
// Separa "user:pass@host:porta" em partes. Sem credencial, devolve so o endereco.
//
// O endereco continua sendo a CHAVE em todo lugar (contagens, mapas de pais, resumo): a credencial
// anda ao lado, nunca dentro dela. Assim ela nao vaza para dentro de nenhuma estrutura que depois
// aparece na resposta, no cache ou no registro.
export function partirEndereco(bruto) {
    const arroba = bruto.lastIndexOf("@");
    if (arroba < 0) return { endereco: bruto, usuario: null, senha: null };

    const credencial = bruto.slice(0, arroba);
    const endereco = bruto.slice(arroba + 1);
    const dois = credencial.indexOf(":");
    if (dois < 0) return { endereco, usuario: null, senha: null };
    return { endereco, usuario: credencial.slice(0, dois), senha: credencial.slice(dois + 1) };
}

// O aperto de mao de usuario e senha do SOCKS5 (RFC 1929), num quadro so.
function quadroDeLogin(usuario, senha) {
    const u = Buffer.from(usuario, "utf8");
    const p = Buffer.from(senha, "utf8");
    return Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]);
}

export function sondar(bruto, { conectarMs = 1200, aperoMs = 2500 } = {}) {
    const { endereco, usuario, senha } = partirEndereco(bruto);
    const comLogin = usuario !== null && senha !== null;
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
            // Oferece os dois metodos quando ha credencial, e so "sem autenticacao" quando nao ha.
            // Oferecer login sem ter o que mandar so faria uma proxy aberta escolher um metodo que
            // depois nao daria para completar.
            socket.write(comLogin ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
        });

        socket.on("data", pedaco => {
            buffer = Buffer.concat([buffer, pedaco]);

            if (fase === "tcp") {
                if (buffer.length < 2) return;
                if (buffer[0] !== 5) return fim();

                // 2 = ela quer usuario e senha. So serve se voce mandou credencial junto.
                if (buffer[1] === 2) {
                    if (!comLogin) return fim();
                    fase = "login";
                    buffer = buffer.subarray(2);
                    socket.write(quadroDeLogin(usuario, senha));
                    return;
                }

                // 0 = sem autenticacao. Qualquer outra coisa (socks4, http, metodo que nao se fala)
                // nao serve.
                if (buffer[1] !== 0) return fim();
                fase = "socks5";
                buffer = buffer.subarray(2);
                socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));   // UDP ASSOCIATE
                return;
            }

            if (fase === "login") {
                if (buffer.length < 2) return;
                // Versao 1 do sub-protocolo, e 0 = aceita. Senha errada morre aqui, e "morre aqui" e
                // uma resposta util: a proxy existe e fala SOCKS5, so nao com essa credencial.
                if (buffer[1] !== 0) { fase = "senha_recusada"; return fim(); }
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
export async function checar(enderecos, { paralelo = 300, orcamentoMs = 45_000, credenciais = new Map(), ...opcoes } = {}) {
    const aprovadas = [];
    const contagem = { testadas: 0, tcp: 0, socks5: 0, semBind: 0, senhaRecusada: 0, udp: 0 };
    const prazo = Date.now() + orcamentoMs;

    let proximo = 0;
    async function trabalhador() {
        while (proximo < enderecos.length && Date.now() < prazo) {
            const endereco = enderecos[proximo++];
            // Com credencial guardada para este endereco, ela vai junto no aperto de mao. O resultado
            // continua chaveado pelo endereco puro.
            const { fase, ms } = await sondar(credenciais.get(endereco) ?? endereco, opcoes);

            contagem.testadas++;
            if (fase !== "morta") contagem.tcp++;
            if (fase === "socks5" || fase === "socks5_sem_bind" || fase === "senha_recusada" || fase === "udp") contagem.socks5++;
            // Contada a parte, e nao junto das boas: a que aceita o ASSOCIATE e devolve porta 0 e o
            // tipo mais enganoso que existe aqui -- passa em todo teste rapido e nao entrega nada.
            // Mostrar quantas sao explica, na propria tela, por que "com UDP" e bem menor que "falam
            // SOCKS5".
            if (fase === "socks5_sem_bind") contagem.semBind++;
            // "A proxy existe e fala SOCKS5, so nao com essa credencial" e uma resposta util: separa
            // "endereco morto" de "senha errada", que sao problemas diferentes.
            if (fase === "senha_recusada") contagem.senhaRecusada++;
            if (fase === "udp") { contagem.udp++; aprovadas.push({ endereco, ms }); }
        }
    }

    await Promise.all(Array.from({ length: Math.min(paralelo, enderecos.length) }, trabalhador));
    return { aprovadas, contagem, completou: proximo >= enderecos.length };
}

// ------------------------------------------------------------------ o pais de saida

// De onde a proxy SAI na internet, perguntado a ela mesma.
//
// Isto existe aqui porque estava saindo caro no lugar errado. As listas publicas quase nao trazem pais
// -- duas das oito trazem --, entao o plugin abria, para cada proxy aprovada, um tunel + TLS + uma
// volta HTTP ate a Cloudflare so para descobrir isso. Numa proxy gratuita essa volta custa de 2 a 4
// segundos e falha com facilidade, e o plugin reprovava a proxy por causa dela -- reprovava por uma
// pergunta que nem era sobre datagrama. O site entregava 79 e sobravam 5.
//
// Feito aqui, a volta acontece UMA vez, num servidor com rede de verdade, para todo mundo. Falhar
// continua sendo aceitavel: a proxy sai com "??" e o plugin a mantem assim.
function paisPelaProxy(bruto, prazoMs) {
    return new Promise(resolve => {
        const { endereco, usuario, senha } = partirEndereco(bruto);
        const comLogin = usuario !== null && senha !== null;
        const corte = endereco.lastIndexOf(":");
        const host = endereco.slice(0, corte);
        const porta = Number(endereco.slice(corte + 1));

        let pronto = false;
        let socket = null;
        let seguro = null;
        const fim = pais => {
            if (pronto) return;
            pronto = true;
            try { seguro?.destroy(); } catch { /* ja foi */ }
            try { socket?.destroy(); } catch { /* ja foi */ }
            resolve(pais);
        };
        const relogio = setTimeout(() => fim(null), prazoMs);

        socket = net.connect({ host, port: porta });
        socket.on("error", () => fim(null));
        socket.on("close", () => fim(null));

        let fase = "saudacao";
        let buffer = Buffer.alloc(0);

        const pedirConnect = () => {
            const alvo = Buffer.from("cloudflare.com", "utf8");
            socket.write(Buffer.concat([
                Buffer.from([5, 1, 0, 3, alvo.length]), alvo, Buffer.from([0x01, 0xbb])
            ]));
        };

        socket.once("connect", () => socket.write(comLogin ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0])));
        socket.on("data", pedaco => {
            if (fase === "tunel") return;
            buffer = Buffer.concat([buffer, pedaco]);

            if (fase === "saudacao") {
                if (buffer.length < 2) return;
                if (buffer[0] !== 5) return fim(null);
                if (buffer[1] === 2) {
                    if (!comLogin) return fim(null);
                    fase = "login";
                    buffer = buffer.subarray(2);
                    socket.write(quadroDeLogin(usuario, senha));
                    return;
                }
                if (buffer[1] !== 0) return fim(null);
                fase = "connect";
                buffer = buffer.subarray(2);
                pedirConnect();
                return;
            }

            if (fase === "login") {
                if (buffer.length < 2) return;
                if (buffer[1] !== 0) return fim(null);
                fase = "connect";
                buffer = buffer.subarray(2);
                pedirConnect();
                return;
            }

            // CONNECT respondido: 4 de cabecalho + endereco + 2 de porta, como no ASSOCIATE.
            if (buffer.length < 5) return;
            if (buffer[1] !== 0) return fim(null);
            const tipo = buffer[3];
            const tamanho = tipo === 1 ? 4 : tipo === 3 ? 1 + buffer[4] : tipo === 4 ? 16 : -1;
            if (tamanho < 0) return fim(null);
            if (buffer.length < 4 + tamanho + 2) return;

            fase = "tunel";
            clearTimeout(relogio);
            const restante = Math.max(500, prazoMs - 200);
            const relogioTls = setTimeout(() => fim(null), restante);

            seguro = tls.connect({ socket, servername: "cloudflare.com" }, () => {
                seguro.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: cloudflare.com\r\nConnection: close\r\n\r\n");
            });
            let corpo = "";
            seguro.on("error", () => { clearTimeout(relogioTls); fim(null); });
            seguro.on("data", d => {
                corpo += d.toString("utf8");
                const achado = /(?:^|\n)loc=([A-Z]{2})/.exec(corpo);
                if (achado !== null) { clearTimeout(relogioTls); fim(achado[1]); }
            });
            seguro.on("end", () => { clearTimeout(relogioTls); fim(null); });
        });
    });
}

// Descobre o pais das aprovadas que ainda nao tem um, dentro de um orcamento proprio.
//
// Nao e obrigatorio: quem nao couber no tempo sai com "??" e continua na lista. Melhor uma lista
// completa com alguns paises desconhecidos do que uma lista curta.
export async function descobrirPaises(aprovadas, paises, { paralelo = 60, orcamentoMs = 12_000, prazoMs = 6000, credenciais = new Map() } = {}) {
    const faltando = aprovadas.map(a => a.endereco).filter(e => !paises.has(e));
    const prazo = Date.now() + orcamentoMs;
    let proximo = 0;
    let achados = 0;

    async function trabalhador() {
        while (proximo < faltando.length && Date.now() < prazo) {
            const endereco = faltando[proximo++];
            const pais = await paisPelaProxy(credenciais.get(endereco) ?? endereco, prazoMs);
            if (pais !== null) { paises.set(endereco, pais); achados++; }
        }
    }

    await Promise.all(Array.from({ length: Math.min(paralelo, faltando.length) }, trabalhador));
    return { pedidos: faltando.length, achados };
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
