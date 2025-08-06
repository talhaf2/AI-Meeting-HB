require('dotenv').config();
const express = require('express');
const cors = require('cors');
const meetingRoutes = require('./src/routers/meetingRoutes');
const hubspotWebpageRoutes = require('./src/routers/hubspotWebpgaeRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
// app.use(express.json());
// app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Increase JSON body size limit to 1MB (or more as needed)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// API routes
app.use('/api', meetingRoutes);
app.use('/api/hubspot-webpage', hubspotWebpageRoutes);

app.listen(port, () => {
    console.log(`Server running at: ${port}`);
});
