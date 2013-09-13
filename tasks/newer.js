var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var async = require('async');

function getStampPath(dir, name, target) {
  return path.join(dir, name, target, 'timestamp');
}

function getHashPath(dir, name, target, filename) {
  var hashedFilename = crypto.createHash('md5').update(filename).digest('hex');
  return path.join(dir, name, target, 'hashes', hashedFilename);
}

function filterSrcByTime(srcFiles, time, callback) {
  async.map(srcFiles, fs.stat, function(err, stats) {
    if (err) {
      return callback(err);
    }
    callback(null, srcFiles.filter(function(filename, index) {
      return stats[index].mtime > time;
    }));
  });
}

function filterFilesByTime(files, previous, callback) {
  var modified = false;
  async.map(files, function(obj, done) {
    var time;
    /**
     * It is possible that there is a dest file that has been created
     * more recently than the last successful run.  This would happen if
     * a target with multiple dest files failed before all dest files were
     * created.  In this case, we don't need to re-run src files that map
     * to dest files that were already created.
     */
    if (obj.dest && fs.existsSync(obj.dest)) {
      time = Math.max(fs.statSync(obj.dest).mtime, previous);
    } else {
      time = previous;
    }

    filterSrcByTime(obj.src, time, function(err, src) {
      if (err) {
        return done(err);
      }
      if (src.length) {
        modified = true;
      }
      done(null, {src: src, dest: obj.dest});
    });
  }, function(err, newerFiles) {
    callback(err, newerFiles, modified);
  });
}

function getExistingHash(filename, dir, name, target, callback) {
  var hashPath = getHashPath(dir, name, target, filename);
  fs.exists(hashPath, function(exists) {
    if (!exists) {
      return callback(null, null);
    }
    fs.readFile(hashPath, callback);
  });
}

function generateFileHash(filename, callback) {
  var md5sum = crypto.createHash('md5');
  var stream = new fs.ReadStream(filename);
  stream.on('data', function(chunk) {
    md5sum.update(chunk);
  });
  stream.on('error', callback);
  stream.on('end', function() {
    callback(null, md5sum.digest('hex'));
  });
}

function filterSrcByHash(srcFiles, dir, name, target, callback) {
  async.filter(srcFiles, function(filename, done) {
    async.parallel({
      previous: function(cb) {
        getExistingHash(filename, dir, name, target, cb);
      },
      current: function(cb) {
        generateFileHash(filename, cb);
      }
    }, function(err, hashes) {
      if (err) {
        return callback(err);
      }
      done(String(hashes.previous) !== String(hashes.current));
    });
  }, callback);
}

function filterFilesByHash(files, name, target, callback) {
  var modified = false;
  async.map(files, function(obj, done) {

    filterSrcByHash(obj.src, name, target, function(err, src) {
      if (err) {
        return done(err);
      }
      if (src.length) {
        modified = true;
      }
      done(null, {src: src, dest: obj.dest});
    });

  }, function(err, newerFiles) {
    callback(err, newerFiles, modified);
  });
}

function createTask(grunt, any) {
  return function(name, target) {
    if (!target) {
      var tasks = [];
      Object.keys(grunt.config(name)).forEach(function(target) {
        if (!/^_|^options$/.test(target)) {
          tasks.push('newer:' + name + ':' + target);
        }
      });
      return grunt.task.run(tasks);
    }
    var args = Array.prototype.slice.call(arguments, 2).join(':');
    var options = this.options({
      timestamps: path.join(__dirname, '..', '.cache')
    });
    var config = grunt.config.get([name, target]);

    /**
     * Special handling for watch task.  This is a multitask that expects
     * the `files` config to be a string or array of string source paths.
     */
    var srcFiles = true;
    if (typeof config.files === 'string') {
      config.src = [config.files];
      delete config.files;
      srcFiles = false;
    } else if (Array.isArray(config.files) &&
        typeof config.files[0] === 'string') {
      config.src = config.files;
      delete config.files;
      srcFiles = false;
    }

    var qualified = name + ':' + target;
    var stamp = getStampPath(options.timestamps, name, target);
    var repeat = grunt.file.exists(stamp);
    if (!repeat) {
      /**
       * This task has never succeeded before.  Process everything.  This is
       * less efficient than it could be for cases where some dest files were
       * created in previous runs that failed, but it makes things easier.
       */
      grunt.task.run([
        qualified + (args ? ':' + args : ''),
        'newer-timestamp:' + qualified + ':' + options.timestamps
      ]);
      return;
    }

    // This task has succeeded before.  Filter src files.

    var done = this.async();

    var previous = fs.statSync(stamp).mtime;
    var files = grunt.task.normalizeMultiTaskFiles(config, target);
    filterFilesByTime(files, previous, function(err, newerFiles, modified) {
      if (err) {
        return done(err);
      }

      /**
       * Cases:
       *
       * 1) Nothing modified, process none.
       * 2) Something modified, any false, process modified.
       * 3) Something modified, any true, process all.
       */
      if (!modified) { // case 1
        grunt.log.writeln('No newer files to process.');
      } else {
        if (!any) { // case 2
          /**
           * If we started out with only src files in the files config,
           * transform the newerFiles array into an array of source files.
           */
          if (!srcFiles) {
            newerFiles = newerFiles.map(function(obj) {
              return obj.src;
            });
          }

          config.files = newerFiles;
          delete config.src;
          delete config.dest;
          grunt.config.set([name, target], config);
        }
        // case 2 or 3
        grunt.task.run([
          qualified + (args ? ':' + args : ''),
          'newer-timestamp:' + qualified + ':' + options.timestamps
        ]);
      }

      done();
    });

  };
}


/** @param {Object} grunt Grunt. */
module.exports = function(grunt) {

  grunt.registerTask(
      'newer', 'Run a task with only those source files that have been ' +
      'modified since the last successful run.', createTask(grunt));

  grunt.registerTask(
      'any-newer', 'Run a task with all source files if any have been ' +
      'modified since the last successful run.', createTask(grunt, true));

  grunt.registerTask(
      'newer-timestamp', 'Internal task.', function(name, target, dir) {
        // if dir includes a ':', grunt will split it among multiple args
        dir = Array.prototype.slice.call(arguments, 2).join(':');
        grunt.file.write(getStampPath(dir, name, target), '');
      });

};
