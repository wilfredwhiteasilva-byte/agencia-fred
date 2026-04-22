import { Handler } from '@netlify/functions';

const handler: Handler = async (event, context) => {
  try {
    const { question, mode = 'full' } = JSON.parse(event.body || '{}');

    if (!question) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Question required' }),
      };
    }

    console.log('Executive Board Question:', question);
    console.log('Mode:', mode);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Executive Board Handler Deployed ✅',
        question: question,
        mode: mode,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

export { handler };
