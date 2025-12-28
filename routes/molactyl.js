const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const axios = require('axios');
const { db } = require('../handlers/db.js');
const config = require('../config.json');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const saltRounds = 10;
const multer = require('multer');
const path = require('path')
const fs = require('node:fs')
const {logAudit} = require('../handlers/auditlog.js');
const nodemailer = require('nodemailer');
const { sendTestEmail } = require('../handlers/email.js');
const { isAuthenticated } = require('../handlers/auth.js');

router.get("/dashboard", isAuthenticated, async (req, res) => {
    if (!req.user) return res.redirect('/');
    let instances = [];

    if (req.query.see === "other") {
        let allInstances = await db.get('instances') || [];
        instances = allInstances.filter(instance => instance.User !== req.user.userId);
    } else {
        const userId = req.user.userId;
        const users = await db.get('users') || [];
        const authenticatedUser = users.find(user => user.userId === userId);
        instances = await db.get(req.user.userId + '_instances') || [];
        const subUserInstances = authenticatedUser.accessTo || [];
        for (const instanceId of subUserInstances) {
            const instanceData = await db.get(`${instanceId}_instance`);
            if (instanceData) {
                instances.push(instanceData);
            }
        }
    }
    const announcement = await db.get('announcement');
    const announcement_data = {
      title: 'Change me',
      description: 'Change me from admin settings',
      type: 'warn'
    };
    
    if (!announcement) {
      console.log('Announcement does not exist. Creating...');
      await db.set('announcement', announcement_data);
      console.log('Announcement created:', await db.get('announcement'));
    }
    
    const default_resources = {
      ram: config.total_resources.ram,
      disk: config.total_resources.disk,
      cores: config.total_resources.cores
    };
    
    const max_resources = await db.get('resources-'+ req.user.email)
    if (!max_resources) {
      console.log('Starting Resources Creation for '+ req.user.email);
      await db.set('resources-' + req.user.email, default_resources);
      console.log('Resources created for '+ req.user.email , await db.get('resources-'+ req.user.email));
    }
    const nodes = await db.get('nodes');
    const images = await db.get('images');
    
    res.render('dashboard', {
      req,
      user: req.user,
      name: await db.get('name') || 'OverSee',
      logo: await db.get('logo') || false,
      instances,
      nodes,
      max_resources,
      images,
      announcement: await db.get('announcement'),
      config: require('../config.json')
    });    
});

router.get("/create-server", isAuthenticated, async (req, res) => {
    if (!req.user) return res.redirect('/');
    let instances = [];

    try {
        if (req.query.see === "other") {
            let allInstances = await db.get('instances') || [];
            instances = allInstances.filter(instance => instance.User !== req.user.userId);
        } else {
            const userId = req.user.userId;
            const users = await db.get('users') || [];
            const authenticatedUser = users.find(user => user.userId === userId);
            instances = await db.get(req.user.userId + '_instances') || [];
            const subUserInstances = authenticatedUser?.accessTo || [];
            for (const instanceId of subUserInstances) {
                const instanceData = await db.get(`${instanceId}_instance`);
                if (instanceData) {
                    instances.push(instanceData);
                }
            }
        }

        // Fetch node IDs and retrieve corresponding node data
        const nodeIds = await db.get('nodes') || [];
        const nodes = [];
        for (const nodeId of nodeIds) {
            const nodeData = await db.get(`${nodeId}_node`);
            if (nodeData) {
                nodes.push(nodeData);
            }
        }

        // Fetch images
        const images = await db.get('images') || [];

        // Render the page
        res.render('create', {
            req,
            user: req.user,
            name: await db.get('name') || 'OverSee',
            logo: await db.get('logo') || false,
            instances,
            nodes,
            images,
            config: require('../config.json')
        });
    } catch (error) {
        console.error("Error fetching data for create-server:", error);
        res.status(500).send("Internal Server Error");
    }
});


router.ws('/afkwspath', async (ws, req) => {
  let earners = [];
  try {
      if (!req.user || !req.user.email || !req.user.userId) {
          console.error('WebSocket connection failed: Missing user data in request.');
          return ws.close();
      }

      if (earners[req.user.email] === true) {
          console.error(`WebSocket connection rejected: User ${req.user.email} is already an earner.`);
          return ws.close();
      }

      const timeConf = process.env.AFK_TIME || 60;
      if (!timeConf) {
          console.error('Environment variable AFK_TIME is not set.');
          return ws.close();
      }

      let time = timeConf;
      earners[req.user.email] = true;

      let aba = setInterval(async () => {
          try {
              if (earners[req.user.email] === true) {
                  time--;
                  if (time <= 0) {
                      time = timeConf;
                      ws.send(JSON.stringify({ "type": "coin" }));
                      let coins = await db.get(`coins-${req.user.email}`);
                      if (!coins) {
                          console.error(`Coins data not found for ${req.user.email}. Initializing to 0.`);
                          coins = 0;
                      }
                      let updatedCoins = parseInt(coins) + 5;
                      await db.set(`coins-${req.user.email}`, updatedCoins);
                  }
                  ws.send(JSON.stringify({ "type": "count", "amount": time }));
              }
          } catch (intervalError) {
              console.error(`Error during interval for user ${req.user.email}:`, intervalError);
          }
      }, 1000);

      ws.on('close', async () => {
          try {
              delete earners[req.user.email];
              clearInterval(aba);
          } catch (closeError) {
              console.error(`Error on WebSocket close for user ${req.user.email}:`, closeError);
          }
      });
  } catch (error) {
      console.error('Error in WebSocket connection handler:', error);
      ws.close();
  }
});

router.get('/afk', async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('afk', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

router.get('/transfer', async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('transfer', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

router.get("/transfercoins", async (req, res) => {
  if (!req.user) return res.redirect(`/`);

    const coins = parseInt(req.query.coins);
    if (!coins || !req.query.email)
    return res.redirect(`/transfer?err=MISSINGFIELDS`);
    if (req.query.email.includes(`${req.user.email}`))
    return res.redirect(`/transfer?err=CANNOTGIFTYOURSELF`);

     if (coins < 1) return res.redirect(`/transfer?err=TOOLOWCOINS`);

    const usercoins = await db.get(`coins-${req.user.email}`);
    const othercoins = await db.get(`coins-${req.query.email}`);

    if (!othercoins) {
      return res.redirect(`/transfer?err=USERDOESNTEXIST`);
    }
    if (usercoins < coins) {
      return res.redirect(`/transfer?err=CANTAFFORD`);
    }

    await db.set(`coins-${req.query.email}`, othercoins + coins);
    await db.set(`coins-${req.user.email}`, usercoins - coins);
    return res.redirect(`/transfer?err=success`);
  });

  router.get('/create', isAuthenticated, async (req, res) => {
    const { image, imageName, ram, cpu, ports, nodeId, name, user, primary, variables } =
      req.query;
  
    // Check for missing parameters
    if (!imageName || !ram || !cpu || !ports || !nodeId || !name || !user || !primary) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
  
    try {
      // Parse the RAM value from the query (in MIB)
      const requestedRam = parseInt(ram, 10);  // Ensure the RAM value is parsed as an integer (in MIB)
      const requestedCore = req.query.cpu;
      // Fetch user resources from the database (should be in MIB as well)
      const user_resources = await db.get('resources-' + req.user.email);
      const availableRam = user_resources.ram;
      const availableCore = user_resources.cores;
      // Compare the requested RAM with the available RAM
      if (requestedRam > availableRam) {
        return res.redirect('../create-server?err=NOT_ENOUGH_RESOURCES');
      }

      if (requestedCore > availableCore) {
        return res.redirect('../create-server?err=NOT_ENOUGH_RESOURCES');
      }
  
      const newRam = availableRam - requestedRam; // Deduct the requested RAM from available RAM
      const newCpu = availableCore - requestedCore; // Deduct the requested cores from available cores
      
      const newResources = {
          ram: newRam,
          disk: 10, // Assuming 10 GiB disk is always allocated
          cores: newCpu,
      };
      
      const Id = uuid().split('-')[0];
      const node = await db.get(`${nodeId}_node`);
      if (!node) {
        return res.status(400).json({ error: 'Invalid node' });
      }
  
      const requestData = await prepareRequestData(
        image,
        requestedRam,
        cpu,
        ports,
        name,
        node,
        Id,
        variables,
        imageName
      );
      const response = await axios(requestData);
  
      await updateDatabaseWithNewInstance(
        response.data,
        user,
        node,
        image,
        requestedRam,
        cpu,
        ports,
        primary,
        name,
        Id,
        imageName
      );
  
      logAudit(req.user.userId, req.user.username, 'instance:create', req.ip);
      await db.set('resources-'+ req.user.email, newResources)
      res.redirect('../dashboard?err=CREATED');
    } catch (error) {
      console.error('Error deploying instance:', error);
      res.redirect('../create-server?err=INTERNALERROR');
    }
  });  

  router.get('/delete/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.redirect('/instances')
    }
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(404).send('Instance not found');
    }
    if (!instance.User === req.user.userId) {
      return res.redirect('/dashboard?err=DO_NOT_OWN')
    }
    const resourcesKey = `resources-${req.user.email}`;
    const userResources = await db.get(resourcesKey) || {};

    const instanceRam = instance.Memory;
    const instanceCPU = instance.Cpu;
    userResources.ram = (userResources.ram || 0) + instanceRam;
    userResources.cores = (userResources.cores || 0) + instanceCPU;
    await db.set(resourcesKey, userResources);
    await deleteInstance(instance);
    res.redirect('/dashboard?err=DELETED');
  });

  router.get('/buyresource/:resource', isAuthenticated,async (req, res) => {
    try {
        const resource = req.params.resource; // Access `resource` as a string
        const coinsKey = `coins-${req.user.email}`;
        const resourcesKey = `resources-${req.user.email}`;

        const coins = await db.get(coinsKey);
        const userResources = await db.get(resourcesKey) || {};

        if (resource === 'ram') {
            if (coins < 150) {
                return res.redirect('../store?err=NOTENOUGHCOINS');
            } else {
                userResources.ram = (userResources.ram || 0) + 1024;
                await db.set(resourcesKey, userResources);
                await db.set(coinsKey, coins - 150); // Deduct coins
                return res.redirect('../store?success=RAMPURCHASED');
            }
        } else if (resource === 'cpu') {
            if (coins < 200) {
                return res.redirect('../store?err=NOTENOUGHCOINS');
            } else {
                userResources.cores = (userResources.cores || 0) + 1;
                await db.set(resourcesKey, userResources);
                await db.set(coinsKey, coins - 200); // Deduct coins
                return res.redirect('../store?success=CPUPURCHASED');
            }
        } else {
            return res.redirect('../store?err=INVALIDRESOURCE');
        }
    } catch (error) {
        console.error('Error processing buyresource request:', error);
        return res.redirect('../store?err=SERVERERROR');
    }
});

router.get('/store', isAuthenticated ,async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('store', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

async function prepareRequestData(image, memory, cpu, ports, name, node, Id, variables, imagename) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  const requestData = {
    method: 'post',
    url: `http://${node.address}:${node.port}/instances/create`,
    auth: {
      username: 'Skyport',
      password: node.apiKey,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      Name: name,
      Id,
      Image: image,
      Env: imageData ? imageData.Env : undefined,
      Scripts: imageData ? imageData.Scripts : undefined,
      Memory: memory ? parseInt(memory) : undefined,
      Cpu: cpu ? parseInt(cpu) : undefined,
      ExposedPorts: {},
      PortBindings: {},
      variables,
      AltImages: imageData ? imageData.AltImages : [],
      StopCommand: imageData ? imageData.StopCommand : undefined,
      imageData,
    },
  };

  if (ports) {
    ports.split(',').forEach(portMapping => {
      const [containerPort, hostPort] = portMapping.split(':');

      // Adds support for TCP
      const tcpKey = `${containerPort}/tcp`;
      if (!requestData.data.ExposedPorts[tcpKey]) {
        requestData.data.ExposedPorts[tcpKey] = {};
      }

      if (!requestData.data.PortBindings[tcpKey]) {
        requestData.data.PortBindings[tcpKey] = [{ HostPort: hostPort }];
      }

      // Adds support for UDP
      const udpKey = `${containerPort}/udp`;
      if (!requestData.data.ExposedPorts[udpKey]) {
        requestData.data.ExposedPorts[udpKey] = {};
      }

      if (!requestData.data.PortBindings[udpKey]) {
        requestData.data.PortBindings[udpKey] = [{ HostPort: hostPort }];
      }
    });
  }

  return requestData;
}

async function updateDatabaseWithNewInstance(
  responseData,
  userId,
  node,
  image,
  memory,
  cpu,
  ports,
  primary,
  name,
  Id,
  imagename,
) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  let altImages = imageData ? imageData.AltImages : [];

  const instanceData = {
    Name: name,
    Id,
    Node: node,
    User: userId,
    ContainerId: responseData.containerId,
    VolumeId: Id,
    Memory: parseInt(memory),
    Cpu: parseInt(cpu),
    Ports: ports,
    Primary: primary,
    Image: image,
    AltImages: altImages,
    StopCommand: imageData ? imageData.StopCommand : undefined,
    imageData,
    Env: responseData.Env,
  };

  const userInstances = (await db.get(`${userId}_instances`)) || [];
  userInstances.push(instanceData);
  await db.set(`${userId}_instances`, userInstances);

  const globalInstances = (await db.get('instances')) || [];
  globalInstances.push(instanceData);
  await db.set('instances', globalInstances);

  await db.set(`${Id}_instance`, instanceData);
}

async function deleteInstance(instance) {
  try {
    await axios.get(`http://Skyport:${instance.Node.apiKey}@${instance.Node.address}:${instance.Node.port}/instances/${instance.ContainerId}/delete`);
    
    let userInstances = await db.get(instance.User + '_instances') || [];
    userInstances = userInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set(instance.User + '_instances', userInstances);
    
    let globalInstances = await db.get('instances') || [];
    globalInstances = globalInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set('instances', globalInstances);
    
    await db.delete(instance.ContainerId + '_instance');
  } catch (error) {
    console.error(`Error deleting instance ${instance.ContainerId}:`, error);
    throw error;
  }
}
module.exports = router;