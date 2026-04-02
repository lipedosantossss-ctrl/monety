// ========================================
// NETLIFY FUNCTION: Webhook Pagamentos (ATUALIZADO - PLANO DE CARREIRA E STATUS)
// ========================================
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  // Configuração de Headers para evitar bloqueios
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    
    console.log("=== RECEBENDO WEBHOOK EVOPAY ===", JSON.stringify(body));

    // 1. Identificar a Transação (Suporta EvoPay)
    const transactionId = body.reference || body.id || body.txid || (event.queryStringParameters ? event.queryStringParameters.id : null);
    if (!transactionId) {
      console.error("ID da transação ausente no Webhook.");
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID ausente' }) };
    }

    // 2. Verificar Status de Pagamento
    // A EvoPay geralmente envia status como "PAID" ou "COMPLETED".
    const statusEvopay = String(body.status).toUpperCase();
    const isPaid = statusEvopay === 'PAID' || statusEvopay === 'COMPLETED' || body.success === true;

    if (!isPaid) {
      console.log(`Pagamento ${transactionId} ainda não foi pago. Status recebido: ${statusEvopay}`);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Aguardando pagamento ou status ignorado' }) };
    }

    // 3. Buscar Depósito Global
    const depositRef = db.collection('deposits').doc(transactionId);
    const depositDoc = await depositRef.get();

    if (!depositDoc.exists) {
      console.log(`Depósito ${transactionId} não encontrado no Firestore.`);
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Depósito não encontrado' }) };
    }

    const depositData = depositDoc.data();
    
    // Evitar processamento duplicado caso a Evopay mande o aviso 2 vezes
    if (depositData.status === 'completed' || depositData.status === 'approved') {
      console.log(`Depósito ${transactionId} já estava aprovado.`);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Pagamento já processado anteriormente' }) };
    }

    const { userId, amount, userName } = depositData;
    const parsedAmount = Number(amount);

    // 4. PROCESSAR PAGAMENTO (Atomicamente com runTransaction para segurança)
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(userId);
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) {
        throw new Error(`Usuário ${userId} não existe`);
      }
      const userData = userSnap.data();

      // --- ATUALIZAÇÃO DO DEPÓSITO ---
      // MUDA O STATUS DE PENDING PARA COMPLETED!
      transaction.update(depositRef, { 
        status: 'completed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // --- ATUALIZAÇÃO DO USUÁRIO ---
      // ADICIONA SALDO E totalDeposited (ESSENCIAL PARA O PLANO DE CARREIRA FUNCIONAR!)
      transaction.update(userRef, {
        balance: admin.firestore.FieldValue.increment(parsedAmount),
        totalDeposited: admin.firestore.FieldValue.increment(parsedAmount)
      });

      // --- HISTÓRICO DO USUÁRIO ---
      // Cria ou atualiza a transação na subcoleção do usuário para aparecer no app com o check verde
      const userTxRef = userRef.collection('transactions').doc(transactionId);
      transaction.set(userTxRef, {
        amount: parsedAmount,
        status: 'completed',
        type: 'deposit',
        description: 'Depósito via PIX',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // --- LÓGICA DE AFILIADOS E COMISSÕES (3 NÍVEIS) ---
      const ref1Id = userData.referredBy || userData.invitedBy;
      
      if (ref1Id) {
        const ref1Ref = db.collection('users').doc(ref1Id);
        const ref1Snap = await transaction.get(ref1Ref);

        if (ref1Snap.exists) {
          const bonus1 = parsedAmount * 0.20; // 20% Nível 1
          transaction.update(ref1Ref, {
            balance: admin.firestore.FieldValue.increment(bonus1),
            totalCommissions: admin.firestore.FieldValue.increment(bonus1)
          });
          transaction.set(ref1Ref.collection('transactions').doc(`bonus1_${transactionId}`), {
            amount: bonus1, 
            status: 'completed', 
            type: 'commission',
            level: 1, 
            description: `Comissão Nível 1 (${userName || 'Usuário'})`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          // Nível 2 (Baseado no referido do Nível 1)
          const ref2Id = ref1Snap.data().referredBy || ref1Snap.data().invitedBy;
          if (ref2Id) {
            const ref2Ref = db.collection('users').doc(ref2Id);
            const ref2Snap = await transaction.get(ref2Ref);
            if (ref2Snap.exists) {
              const bonus2 = parsedAmount * 0.05; // 5% Nível 2
              transaction.update(ref2Ref, {
                balance: admin.firestore.FieldValue.increment(bonus2),
                totalCommissions: admin.firestore.FieldValue.increment(bonus2)
              });
              transaction.set(ref2Ref.collection('transactions').doc(`bonus2_${transactionId}`), {
                amount: bonus2, 
                status: 'completed', 
                type: 'commission',
                level: 2, 
                description: `Comissão Nível 2 (${userName || 'Usuário'})`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });

              // Nível 3
              const ref3Id = ref2Snap.data().referredBy || ref2Snap.data().invitedBy;
              if (ref3Id) {
                const ref3Ref = db.collection('users').doc(ref3Id);
                const ref3Snap = await transaction.get(ref3Ref);
                if (ref3Snap.exists) {
                  const bonus3 = parsedAmount * 0.01; // 1% Nível 3
                  transaction.update(ref3Ref, {
                    balance: admin.firestore.FieldValue.increment(bonus3),
                    totalCommissions: admin.firestore.FieldValue.increment(bonus3)
                  });
                  transaction.set(ref3Ref.collection('transactions').doc(`bonus3_${transactionId}`), {
                    amount: bonus3, 
                    status: 'completed', 
                    type: 'commission',
                    level: 3, 
                    description: `Comissão Nível 3 (${userName || 'Usuário'})`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                }
              }
            }
          }
        }
      }
    });

    console.log(`=== SUCESSO: Depósito ${transactionId} processado! ===`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (error) {
    console.error("=== ERRO WEBHOOK ===", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
