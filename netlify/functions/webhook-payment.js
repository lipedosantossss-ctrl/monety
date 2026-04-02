const admin = require('firebase-admin');

// Inicializa o admin caso ainda não tenha sido inicializado
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Substitui as quebras de linha na chave privada
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'), 
    }),
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  // Apenas aceita método POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const { reference, status } = data;

    // Se o status não for PAID, não precisamos fazer a transação
    if (status !== 'PAID') {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Status ignorado.' }),
      };
    }

    const depositRef = db.collection('deposits').doc(reference);

    // Inicia a transação no Firestore
    await db.runTransaction(async (transaction) => {
      // =========================================================
      // FASE 1: APENAS LEITURAS (Todos os GETs devem ficar aqui)
      // =========================================================
      const depositSnap = await transaction.get(depositRef);

      if (!depositSnap.exists) {
        throw new Error('Depósito não encontrado.');
      }

      const depositData = depositSnap.data();

      // Proteção para não processar o mesmo depósito duas vezes
      if (depositData.status === 'PAID') {
        throw new Error('Este depósito já foi processado anteriormente.');
      }

      const userId = depositData.userId;
      const amount = depositData.amount;
      const userRef = db.collection('users').doc(userId);
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error('Usuário não encontrado.');
      }

      const userData = userSnap.data();
      
      // Variáveis para armazenar as referências e dados dos afiliados (se existirem)
      let level1Ref, level2Ref, level3Ref;
      let level1Data, level2Data, level3Data;

      // Lê o Nível 1
      if (userData.referredBy) {
        level1Ref = db.collection('users').doc(userData.referredBy);
        const level1Snap = await transaction.get(level1Ref);
        if (level1Snap.exists) {
          level1Data = level1Snap.data();

          // Lê o Nível 2
          if (level1Data.referredBy) {
            level2Ref = db.collection('users').doc(level1Data.referredBy);
            const level2Snap = await transaction.get(level2Ref);
            if (level2Snap.exists) {
              level2Data = level2Snap.data();

              // Lê o Nível 3
              if (level2Data.referredBy) {
                level3Ref = db.collection('users').doc(level2Data.referredBy);
                const level3Snap = await transaction.get(level3Ref);
                if (level3Snap.exists) {
                  level3Data = level3Snap.data();
                }
              }
            }
          }
        }
      }

      // =========================================================
      // CÁLCULOS NA MEMÓRIA (Nenhuma gravação no banco ainda)
      // =========================================================
      
      // 1. Atualiza saldo e adiciona 1 giro na roleta para quem depositou
      const novoSaldoUsuario = (userData.balance || 0) + amount;
      const novosGirosRoleta = (userData.girosRoleta || 0) + 1;

      // 2. Calcula as comissões da rede (20%, 5%, 1%)
      let novoSaldoNivel1, novoSaldoNivel2, novoSaldoNivel3;
      let girosNivel1;

      if (level1Data) {
        novoSaldoNivel1 = (level1Data.balance || 0) + (amount * 0.20);
        // Bônus de giro para o patrocinador direto (se aplicável na sua regra)
        girosNivel1 = (level1Data.girosRoleta || 0) + 1; 
      }
      if (level2Data) {
        novoSaldoNivel2 = (level2Data.balance || 0) + (amount * 0.05);
      }
      if (level3Data) {
        novoSaldoNivel3 = (level3Data.balance || 0) + (amount * 0.01);
      }

      // =========================================================
      // FASE 2: APENAS GRAVAÇÕES (Todos os UPDATEs devem ficar aqui)
      // =========================================================
      
      // Atualiza o status do depósito
      transaction.update(depositRef, { 
        status: 'PAID',
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Atualiza o usuário (Saldo + Giro)
      transaction.update(userRef, { 
        balance: novoSaldoUsuario,
        girosRoleta: novosGirosRoleta
      });

      // Atualiza o Nível 1 (Saldo + Giro)
      if (level1Ref && level1Data) {
        transaction.update(level1Ref, { 
          balance: novoSaldoNivel1,
          girosRoleta: girosNivel1 
        });
      }

      // Atualiza o Nível 2 (Apenas saldo)
      if (level2Ref && level2Data) {
        transaction.update(level2Ref, { balance: novoSaldoNivel2 });
      }

      // Atualiza o Nível 3 (Apenas saldo)
      if (level3Ref && level3Data) {
        transaction.update(level3Ref, { balance: novoSaldoNivel3 });
      }
    });

    // Se chegou até aqui, a transação foi um sucesso absoluto
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Depósito e comissões processados com sucesso.' }),
    };

  } catch (error) {
    console.error('Erro na transação de webhook:', error);
    return {
      statusCode: 500, // Retorna 500 para o gateway tentar enviar o webhook de novo mais tarde
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
