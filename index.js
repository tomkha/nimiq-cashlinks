const Nimiq = require('@nimiq/core');
const QRCode = require('qrcode-svg');

const fs = require('fs');
const util = require('util');
const writeFile = util.promisify(fs.writeFile);

const TAG = 'CashlinkGenerator';
Nimiq.Log.instance.level = 'info';

const test = true;
const value = Nimiq.Policy.coinsToLunas(5);
const count = 64;
const message = 'Hi there!';
const requiredConfirmations = 2;
const seed = undefined;

if (count > Nimiq.Mempool.TRANSACTIONS_PER_SENDER_MAX) {
    console.error(`Maximum number of cashlinks: ${Nimiq.Mempool.TRANSACTIONS_PER_SENDER_MAX}`);
    process.exit(1);
}

const fee = (count <= Nimiq.Mempool.FREE_TRANSACTIONS_PER_SENDER_MAX) ? 0 : 138 * Nimiq.Mempool.TRANSACTION_RELAY_FEE_MIN; // 138 bytes = basic tx size
const totalAmount = count * (value + fee);

async function getBalance(client, address) {
    return (await client.getAccount(address)).balance;
}

function createTransactionRequest(address, value, test = false) {
    return `https://safe.nimiq${test ? '-testnet' : ''}.com/#_request/${address.toUserFriendlyAddress(false)}/${Nimiq.Policy.lunasToCoins(value)}_`;
}

function createCashlink(privateKey, value, message = '', test = false) {
    const messageBytes = new Nimiq.SerialBuffer(Buffer.from(message, 'UTF-8'));

    const buffer = new Nimiq.SerialBuffer(
        Nimiq.PrivateKey.SIZE // key
        + 8 // value
        + (messageBytes.byteLength ? 1 : 0) // message length
        + messageBytes.byteLength // message
    );

    privateKey.serialize(buffer);
    buffer.writeUint64(value);
    if (messageBytes.byteLength) {
        buffer.writeUint8(messageBytes.byteLength);
        buffer.write(messageBytes);
    }

    const encoded = Nimiq.BufferUtils.toBase64Url(buffer).replace(/\./g, '=');
    return `https://hub.nimiq${test ? '-testnet' : ''}.com/cashlink/#${encoded}`;
}

function createSVG(cashlinks) {

    const n = 8;
    const size = 200;

    const qrcodes = cashlinks.map(cashlink => {
        const qrcode = new QRCode({
            content: cashlink,
            join: true,
            ecl: 'M',
            padding: 4,
            width: size,
            height: size,
            container: 'svg'
        });
        const svg = qrcode.svg();
        return svg.match(/\s+d="([^"]+)"/)[1];
    });

    let svg = '<?xml version="1.0" standalone="yes"?>';
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${n * size}" height="${n * size}" viewBox="0 0 ${n * size} ${n * size}">`;
    svg += '<rect x="0" y="0" width="100%" height="100%" fill="white" stroke="none" />';
    svg += '<g style="fill:#000000;shape-rendering:crispEdges;">';
    qrcodes.forEach((qrcode, index) => {
        const x = size * (index % n);
        const y = size * Math.floor(index / n);
        svg += `<path transform="translate(${x},${y})" d="${qrcode}" />`;
    });
    svg += '</g>';
    svg += '</svg>';
    return svg;
}

(async () => {

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[test ? 'test' : 'main']);
    Nimiq.Log.i(TAG, `Connecting to Nimiq ${Nimiq.GenesisConfig.NETWORK_NAME} network`);

    const client = Nimiq.Client.Configuration.builder()
        .blockConfirmations(requiredConfirmations)
        .instantiateClient();

    client.addHeadChangedListener(async (hash, reason) => {
        const head = await client.getBlock(hash, false);
        Nimiq.Log.i(TAG, `Now at block: ${head.height} (${reason})`);
    });

    await client.waitForConsensusEstablished();

    let wallet;
    if (seed) {
        wallet = Nimiq.Wallet.loadPlain(seed);
        Nimiq.Log.i(TAG, `Wallet loaded from seed: ${wallet.address.toUserFriendlyAddress()}`);
    } else {
        wallet = Nimiq.Wallet.generate();
        Nimiq.Log.i(TAG, `Generated temporary wallet: ${wallet.address.toUserFriendlyAddress()}`);

        let mnemonic = Nimiq.MnemonicUtils.entropyToLegacyMnemonic(wallet.keyPair.privateKey.serialize());
        mnemonic = [...Array(mnemonic.length / 4)].map((_, idx) => mnemonic.slice(4 * idx, 4 * (idx + 1))); // split by 4 words
        Nimiq.Log.i(TAG, `Here is the mnemonic (just in case):\n${mnemonic.map(words => words.join(' ')).join('\n')}`);
    }

    let balance = await getBalance(client, wallet.address);
    if (balance < totalAmount) {
        Nimiq.Log.i(TAG, `Fund ${wallet.address.toUserFriendlyAddress()} with ${Nimiq.Policy.lunasToCoins(totalAmount - balance)} NIM:\n${createTransactionRequest(wallet.address, totalAmount - balance, test)}`);

        /** @type {Promise<Number>} */
        let handle;
        await new Promise(resolve => {
            // Client.addHeadChangedListener is async (not really)
            handle = client.addHeadChangedListener(async () => {
                const currentBalance = await getBalance(client, wallet.address);
                if (currentBalance >= totalAmount) {
                    resolve();
                    return;
                }
                if (currentBalance > balance) {
                    Nimiq.Log.i(TAG, `Got ${Nimiq.Policy.lunasToCoins(currentBalance - balance)} NIM, ${Nimiq.Policy.lunasToCoins(totalAmount - currentBalance)} more NIM to go`);
                    balance = currentBalance;
                }
            });
        });
        client.removeListener(await handle);
    }

    const keyPairs = [...Array(count)].map(() => Nimiq.KeyPair.generate());
    const cashlinks = keyPairs.map(keyPair => createCashlink(keyPair.privateKey, value, message, test));
    Nimiq.Log.i(TAG, `Created ${count} cashlinks:\n${cashlinks.join('\n')}`);

    const svg = createSVG(cashlinks);
    await writeFile(`cashlinks_${Date.now()}.svg`, svg);


    const validityStartHeight = await client.getHeadHeight();
    const transactions = keyPairs.map(keyPair => wallet.createTransaction(keyPair.publicKey.toAddress(), value, fee, validityStartHeight));
    const txDetails = await Promise.all(transactions.map(tx => client.sendTransaction(tx)));
    const txHashes = txDetails.map(tx => tx.transactionHash);

    Nimiq.Log.i(TAG, 'Charging cashlinks');

    /*
    client.addHeadChangedListener(async () => {
        const details = await Promise.all(txHashes.map(hash => client.getTransaction(hash)));
        const confirmed = details.reduce((confirmed, tx) => confirmed & (tx.state === 'confirmed'), true);
        if (confirmed) {
            Nimiq.Log.i(TAG, 'All transactions confirmed');
            process.exit(0);
        }
    });
    */

})().catch(e => {
    console.error(e);
    process.exit(1);
});
