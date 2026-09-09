// GET /api/proxies
//
// Devolve as proxies que passaram, ordenadas. Formatos:
//   /api/proxies             -> JSON com metadados. E o que a interface usa, e tambem o que o plugin
//                               le: so aqui vai o pais de cada saida, e sem ele o plugin gastaria uma
//                               conexao por proxy para redescobrir isso
//   /api/proxies?formato=txt -> uma por linha, "socks5://ip:porta", para colar em outra ferramenta
//   /api/proxies?limite=50   -> corta a lista
//
// A conta cara e feita UMA vez e servida do cache da CDN. Sem isso, cada visita a pagina dispararia
// uma varredura de dezenas de milhares de enderecos -- o que, alem de lento, viraria um pequeno ataque
// contra as listas publicas.
import { juntarFontes, checar, ranquear, descobrirPaises, lerMinhas, temCredencial } from "./_checker.js";

// De onde saem os numeros: da variavel de ambiente quando houver, senao de um padrao conservador que
// cabe no tempo de funcao do plano gratuito.
const numero = (nome, padrao) => {
    const bruto = Number(process.env[nome]);
    return Number.isFinite(bruto) && bruto > 0 ? bruto : padrao;
};

// Le o corpo de um POST. Credencial vem por aqui, e nao pela URL.
function lerCorpo(req) {
    return new Promise(resolve => {
        let bruto = "";
        req.on("data", p => { bruto += p; if (bruto.length > 64 * 1024) { bruto = ""; req.destroy(); } });
        req.on("end", () => resolve(bruto));
        req.on("error", () => resolve(""));
    });
}

export default async function handler(req, res) {
    const url = new URL(req.url, "http://local");
    const formato = url.searchParams.get("formato") ?? "json";
    const limite = numero("LIMITE", 0) || Number(url.searchParams.get("limite")) || 0;

    try {
        const comecou = Date.now();

        // Os enderecos que voce colou vem em "?minhas=", separados por virgula. Ficam na frente da fila
        // e sao contados a parte no resumo. Teto baixo de proposito: este endpoint e publico, e sem
        // limite ele viraria um scanner de porta para qualquer um apontar onde quisesse.
        // Por POST tambem, e e por POST que a credencial anda.
        //
        // URL com senha dentro entra em registro de servidor, historico do navegador, Referer e cache
        // compartilhado -- lugares que ninguem limpa e que nao sao seus. Corpo de POST nao vai para
        // nenhum deles, e a resposta de um POST nao e cacheada. Entao: sem senha, GET serve; com
        // senha, so POST. Recusar e melhor do que aceitar e a senha acabar num log de CDN.
        let bruto = url.searchParams.get("minhas");
        if (req.method === "POST") {
            const corpo = await lerCorpo(req);
            try { bruto = JSON.parse(corpo).minhas ?? bruto; }
            catch { bruto = new URLSearchParams(corpo).get("minhas") ?? bruto; }
        }

        const minhas = lerMinhas(bruto, numero("MINHAS_TETO", 50));
        const comSenha = temCredencial(minhas);

        if (comSenha && req.method !== "POST") {
            res.setHeader("cache-control", "no-store");
            return res.status(400).json({
                erro: "Endereco com usuario e senha so por POST",
                porque: "URL com senha dentro fica em registro de servidor, historico e cache compartilhado. "
                    + "O corpo de um POST nao vai para nenhum desses lugares.",
                comoFazer: "POST /api/proxies com {\"minhas\": \"user:senha@ip:porta\"} — e o que a propria pagina faz."
            });
        }

        const { enderecos, paises, origem, credenciais, resumo, totalUnico } = await juntarFontes({
            prazoFonte: numero("PRAZO_FONTE_MS", 15_000),
            teto: numero("TETO", 40_000),
            minhas
        });

        const { aprovadas, contagem, completou } = await checar(enderecos, {
            credenciais,
            paralelo: numero("PARALELO", 300),
            orcamentoMs: numero("ORCAMENTO_MS", 45_000),
            conectarMs: numero("CONECTAR_MS", 1200),
            aperoMs: numero("APERTO_MS", 2500)
        });

        // O pais de cada aprovada, descoberto AQUI.
        //
        // As listas publicas quase nao trazem pais, e sem ele o plugin abria uma volta ate a Cloudflare
        // por proxy, na maquina de quem usa -- 2 a 4 segundos cada, falhando com facilidade. Feito uma
        // vez aqui, num servidor com rede de verdade, todo mundo recebe a lista ja com o pais.
        //
        // So para as APROVADAS (dezenas, nao milhares) e com orcamento proprio: quem nao couber no
        // tempo sai como "??" e continua na lista.
        const geo = await descobrirPaises(aprovadas, paises, {
            credenciais,
            paralelo: numero("GEO_PARALELO", 60),
            orcamentoMs: numero("GEO_ORCAMENTO_MS", 12_000),
            prazoMs: numero("GEO_PRAZO_MS", 6000)
        });

        const ranque = ranquear(aprovadas, paises, origem);
        const lista = limite > 0 ? ranque.slice(0, limite) : ranque;

        // UM minuto de validade, e uma hora servindo o antigo enquanto revalida.
        //
        // E assim que "checar a cada minuto" acontece sem depender de plano pago: passado o minuto, a
        // proxima visita recebe NA HORA a lista da rodada anterior e a CDN dispara a nova varredura por
        // baixo. Ninguem espera, e a lista nunca tem mais de um minuto de idade enquanto houver alguem
        // (o plugin inclusive) batendo aqui.
        //
        // E por isto que nao ha cron: o plano gratuito da Vercel aceita no maximo um por dia, e um
        // agendamento mais frequente RECUSA O DEPLOY inteiro em vez de ser ignorado. O cron seria so um
        // piso para quando nao ha ninguem acessando -- nao vale o projeto nao subir.
        // Resposta de pedido COM CREDENCIAL nao entra em cache nenhum: ela e de uma pessoa so, e um
        // cache compartilhado guardando isso e uma lista privada servida para o proximo que passar.
        res.setHeader("cache-control", comSenha
            ? "private, no-store"
            : "public, s-maxage=60, stale-while-revalidate=3600");
        res.setHeader("access-control-allow-origin", "*");

        if (formato === "txt") {
            res.setHeader("content-type", "text/plain; charset=utf-8");
            return res.status(200).send(lista.map(p => p.proxy).join("\n"));
        }

        res.setHeader("content-type", "application/json; charset=utf-8");
        return res.status(200).json({
            geradoEm: new Date().toISOString(),
            levouMs: Date.now() - comecou,
            // "completou" falso quer dizer que o orcamento de tempo acabou antes da lista. Nao e erro:
            // e o que deu para testar nesta rodada, e esta dito em vez de escondido.
            completou,
            candidatas: enderecos.length,
            totalUnicoNasFontes: totalUnico,
            ...contagem,
            // Quantas ficaram sem pais. E o numero que explica um ranking cheio de "??" -- em vez de
            // parecer que o site esqueceu de preencher.
            semPais: ranque.filter(p => p.pais === "??").length,
            senhaRecusada: contagem.senhaRecusada,
            // Quantas voce colou, e quantas delas passaram. E a resposta para "as minhas prestam?", que
            // o total nao dá: la elas ficam misturadas com as gratuitas.
            minhas: minhas.length,
            minhasAprovadas: ranque.filter(p => p.fonte === "suas").length,
            geo,
            fontes: resumo,
            // O que este checker NAO prova, dito no proprio corpo da resposta para nao virar
            // mal-entendido: a Vercel nao envia UDP, entao "udp" aqui quer dizer que a proxy ACEITOU o
            // pedido de ASSOCIATE, nao que o datagrama atravessa. Essa ultima prova e do plugin.
            aviso: "udp = a proxy aceitou UDP ASSOCIATE. Se o datagrama realmente atravessa, so o cliente consegue provar.",
            proxies: lista
        });
    } catch (erro) {
        res.setHeader("cache-control", "no-store");
        return res.status(500).json({ erro: erro instanceof Error ? erro.message : String(erro) });
    }
}
